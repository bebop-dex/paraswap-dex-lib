import { Network } from '../../../../constants';
import { UniswapV3Config } from '../../config';
import { getDexKeysWithNetwork } from '../../../../utils';
import _ from 'lodash';
import { VelodromeSlipstream } from '../velodrome-slipstream/velodrome-slipstream';
import { Address } from '../../../../types';
import { PoolLiquidity } from '../../../../types';
import { MultiCallParams } from '../../../../lib/multi-wrapper';
import { uint24ToBigInt } from '../../../../lib/decoders';
import { Interface } from '@ethersproject/abi';
import RamsesV3PoolABI from '../../../../abi/ramses-v3/RamsesV3Pool.abi.json';
import { VelodromeSlipstreamEventPool } from '../velodrome-slipstream/velodrome-slipstream-pool';
import {
  UNISWAPV3_CLEAN_NOT_EXISTING_POOL_TTL_MS,
  UNISWAPV3_CLEAN_NOT_EXISTING_POOL_INTERVAL_MS,
} from '../../uniswap-v3';

export class RamsesV3 extends VelodromeSlipstream {
  public static dexKeysWithNetwork: { key: string; networks: Network[] }[] =
    getDexKeysWithNetwork(_.pick(UniswapV3Config, ['RamsesV3']));

  protected readonly poolIface = new Interface(RamsesV3PoolABI);

  private static readonly FEE_REFRESH_INTERVAL_MS = 60 * 1000;
  protected feeUpdateIntervalTask?: NodeJS.Timeout;

  async initializePricing(blockNumber: number) {
    await this.factory.initialize(blockNumber);

    if (!this.dexHelper.config.isSlave) {
      const cleanExpiredNotExistingPoolsKeys = async () => {
        const maxTimestamp =
          Date.now() - UNISWAPV3_CLEAN_NOT_EXISTING_POOL_TTL_MS;
        await this.dexHelper.cache.zremrangebyscore(
          this.notExistingPoolSetKey,
          0,
          maxTimestamp,
        );
      };

      void cleanExpiredNotExistingPoolsKeys();

      this.intervalTask = setInterval(
        cleanExpiredNotExistingPoolsKeys.bind(this),
        UNISWAPV3_CLEAN_NOT_EXISTING_POOL_INTERVAL_MS,
      );
    } else {
      void this.updateAllPoolFees();

      this.feeUpdateIntervalTask = setInterval(
        this.updateAllPoolFees.bind(this),
        RamsesV3.FEE_REFRESH_INTERVAL_MS,
      );
    }
  }

  protected buildFeeCallData(
    pools: VelodromeSlipstreamEventPool[],
  ): MultiCallParams<bigint>[] {
    return pools.map(pool => ({
      target: pool.poolAddress,
      callData: this.poolIface.encodeFunctionData('fee', []),
      decodeFunction: uint24ToBigInt,
    }));
  }

  protected async updateAllPoolFees(): Promise<void> {
    try {
      const activePools = Object.values(this.eventPools).filter(
        pool => pool !== null,
      ) as VelodromeSlipstreamEventPool[];

      if (activePools.length === 0) {
        this.logger.warn(`${this.dexKey}: No active pools to update fees for`);
        return;
      }

      this.logger.info(
        `${this.dexKey}: Updating fees for ${activePools.length} pools`,
      );

      const callData = this.buildFeeCallData(activePools);

      const results = await this.dexHelper.multiWrapper.tryAggregate<bigint>(
        false,
        callData,
      );

      const updateBlockNumber = await this.dexHelper.provider.getBlockNumber();

      activePools.forEach((pool, index) => {
        if (!results[index].success) {
          this.logger.warn(
            `${this.dexKey}: Failed to fetch fee for pool ${pool.poolAddress}`,
          );
          return;
        }

        const newFee = results[index].returnData;
        const currentState = pool.getStaleState();

        if (!currentState) {
          this.logger.debug(
            `${this.dexKey}: No state available for pool ${pool.poolAddress}, skipping fee update`,
          );
          return;
        }

        if (currentState.fee !== newFee) {
          const newState = { ...currentState, fee: newFee };
          pool.setState(newState, updateBlockNumber);

          this.logger.debug(
            `${this.dexKey}: Updated fee for pool ${pool.poolAddress}: ${currentState.fee} -> ${newFee}`,
          );
        }
      });
    } catch (error) {
      this.logger.error(`${this.dexKey}: Error updating pool fees:`, error);
    }
  }

  releaseResources() {
    super.releaseResources();

    if (this.feeUpdateIntervalTask !== undefined) {
      clearInterval(this.feeUpdateIntervalTask);
      this.feeUpdateIntervalTask = undefined;
    }
  }

  async getTopPoolsForToken(
    tokenAddress: Address,
    limit: number,
  ): Promise<PoolLiquidity[]> {
    if (!this.config.subgraphURL) return [];

    const _tokenAddress = tokenAddress.toLowerCase();

    const res = await this._querySubgraph(
      `query ($token: Bytes!, $count: Int) {
                pools0: clPools(first: $count, orderBy: totalValueLockedUSD, orderDirection: desc, where: {token0: $token}) {
                id
                token0 {
                  id
                  decimals
                }
                token1 {
                  id
                  decimals
                }
                totalValueLockedUSD
              }
              pools1: clPools(first: $count, orderBy: totalValueLockedUSD, orderDirection: desc, where: {token1: $token}) {
                id
                token0 {
                  id
                  decimals
                }
                token1 {
                  id
                  decimals
                }
                totalValueLockedUSD
              }
            }`,
      {
        token: _tokenAddress,
        count: limit,
      },
    );

    if (!(res && res.pools0 && res.pools1)) {
      this.logger.error(
        `Error_${this.dexKey}_Subgraph: couldn't fetch the pools from the subgraph`,
      );
      return [];
    }

    const pools0 = _.map(res.pools0, (pool: any) => ({
      exchange: this.dexKey,
      address: pool.id.toLowerCase(),
      connectorTokens: [
        {
          address: pool.token1.id.toLowerCase(),
          decimals: parseInt(pool.token1.decimals),
        },
      ],
      liquidityUSD: parseFloat(pool.totalValueLockedUSD ?? 0),
    }));

    const pools1 = _.map(res.pools1, (pool: any) => ({
      exchange: this.dexKey,
      address: pool.id.toLowerCase(),
      connectorTokens: [
        {
          address: pool.token0.id.toLowerCase(),
          decimals: parseInt(pool.token0.decimals),
        },
      ],
      liquidityUSD: parseFloat(pool.totalValueLockedUSD ?? 0),
    }));

    const pools = _.slice(
      _.sortBy(_.concat(pools0, pools1), [pool => -1 * pool.liquidityUSD]),
      0,
      limit,
    );

    return pools;
  }
}
