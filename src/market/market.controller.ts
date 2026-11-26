import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MarketService } from './market.service';
import { MarketFactoryService } from './market-factory.service';
import { StellarService } from './stellar.service';
import { FaucetService } from './faucet.service';
import { AdminGuard } from './admin.guard';
import { CreateMarketDto } from './dto/create-market.dto';
import { WatchMarketDto } from './dto/watch-market.dto';
import { FaucetDto } from './dto/faucet.dto';
import { OddsSnapshotRepository } from './odds-snapshot.repository';
import { AdminActivityRepository } from './admin-activity.repository';

@Controller('markets')
export class MarketController {
  constructor(
    private readonly markets: MarketService,
    private readonly factory: MarketFactoryService,
    private readonly stellar: StellarService,
    private readonly faucet: FaucetService,
    private readonly config: ConfigService,
    private readonly oddsSnapshots: OddsSnapshotRepository,
    private readonly activity: AdminActivityRepository,
  ) {}

  private validateId(id: string) {
    if (id.length !== 56) {
      throw new BadRequestException('id must be a 56‑character contract identifier');
    }
  }


  @Get()
  list(@Query('feedId') feedId?: string) {
    if (feedId === undefined) return this.markets.list();
    const parsed = Number(feedId);
    if (Number.isNaN(parsed)) throw new BadRequestException('feedId must be a number');
    return this.markets.list(parsed);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    this.validateId(id);
    const m = this.markets.get(id);
    if (!m) throw new NotFoundException(`no tracked market ${id}`);
    return m;
  }

  @Get(':id/state')
  async state(@Param('id') id: string) {
    this.validateId(id);
    // getMarketState already returns a fully normalized (camelCase,
    // stringified bigints, unwrapped status) object — see StellarService's
    // normalizeMarket for why the raw contract.Spec decode needs that step.
    return this.stellar.getMarketState(id);
  }

  @Get(':id/position')
  async position(@Param('id') id: string, @Query('address') address: string) {
    this.validateId(id);
    if (!address) throw new BadRequestException('address query param is required');
    const [yes, no] = await this.stellar.getPosition(id, address);
    return { yes: yes.toString(), no: no.toString() };
  }

  /**
   * `yesBpsChange` is the real thing the frontend's ticker "Chg" column
   * shows — computed against `OddsSnapshotService`'s recorded history, not
   * fabricated. `null` (not `0`) when no snapshot exists far enough back
   * yet (a market younger than `oddsChangeWindowSecs`, or the snapshot
   * service hadn't run at all) — `0` would claim "no movement", which is
   * a different, false, claim from "no history to compare against yet".
   */
  @Get(':id/price')
  async price(@Param('id') id: string) {
    this.validateId(id);
    const current = await this.stellar.getPrice(id);
    const windowSecs = this.config.get<number>('oddsChangeWindowSecs')!;
    const past = this.oddsSnapshots.closestBefore(id, Date.now() - windowSecs * 1000);
    return {
      ...current,
      yesBpsChange: past ? current.yesBps - past.yesBps : null,
    };
  }

  @Get(':id/fee')
  async fee(@Param('id') id: string) {
    this.validateId(id);
    return { feeBps: await this.stellar.getFee(id) };
  }

  @Post('faucet')
  @HttpCode(200)
  async fundFaucet(@Body() dto: FaucetDto) {
    if (!this.faucet.tryConsume(dto.address)) {
      throw new HttpException('faucet rate limit exceeded — try again in an hour', HttpStatus.TOO_MANY_REQUESTS);
    }
    return this.faucet.fund(dto.address);
  }

  @Post('create')
  @UseGuards(AdminGuard)
  async create(@Body() dto: CreateMarketDto) {
    const lazerContract = this.config.get<string>('lazerContract');
    const nativeXlmSac = this.config.get<string>('nativeXlmSac');
    const treasury = this.config.get<string>('treasuryAddress') ?? this.stellar.oraclePublicKey;
    const feedId = this.config.get<number>('xlmUsdFeedId')!;
    const reflectorContract = this.config.get<string>('reflectorContract');
    if (!lazerContract || !nativeXlmSac || !reflectorContract) {
      throw new BadRequestException(
        'LAZER_CONTRACT, NATIVE_XLM_SAC, and REFLECTOR_CONTRACT must be configured to create a market',
      );
    }

    const { contractId, initTxHash } = await this.stellar.deployMarket({
      strikePriceCents: BigInt(dto.strikePriceCents),
      expiry: BigInt(dto.expiry),
      gracePeriodSecs: BigInt(dto.gracePeriodSecs),
      lazerContract,
      feedId,
      baseFeeBps: dto.baseFeeBps,
      minFeeBps: dto.minFeeBps,
      treasury,
      initialLiquidityStroops: BigInt(dto.initialLiquidityStroops),
      collateralAsset: nativeXlmSac,
      reflectorContract,
      reflectorAsset: this.config.get<string>('reflectorAsset')!,
      reflectorMaxStalenessSecs: BigInt(this.config.get<string>('reflectorMaxStalenessSecs')!),
      reflectorToleranceBps: this.config.get<number>('reflectorToleranceBps')!,
    });

    const watched = this.markets.watch({
      contractId,
      strikePriceCents: dto.strikePriceCents,
      expiry: dto.expiry,
      gracePeriodSecs: dto.gracePeriodSecs,
      feedId,
    });

    this.activity.recordAdminAction({
      action: 'create',
      targetContractId: contractId,
      paramsJson: JSON.stringify(dto),
      result: 'ok',
    });

    return { ...watched, initTxHash };
  }

  @Post('factory/run')
  @UseGuards(AdminGuard)
  @HttpCode(200)
  async runFactory() {
    const result = await this.factory.run();
    this.activity.recordAdminAction({ action: 'factory/run', result: 'ok' });
    return result;
  }

  @Post('watch')
  @UseGuards(AdminGuard)
  async watch(@Body() dto: WatchMarketDto) {
    const state = await this.stellar.getMarketState(dto.contractId);
    const watched = this.markets.watch({
      contractId: dto.contractId,
      strikePriceCents: state.strikePrice,
      expiry: Number(state.expiry),
      gracePeriodSecs: Number(state.gracePeriod),
      feedId: state.feedId,
    });
    this.activity.recordAdminAction({ action: 'watch', targetContractId: dto.contractId, result: 'ok' });
    return watched;
  }

  @Post(':id/settle')
  @UseGuards(AdminGuard)
  @HttpCode(200)
  async settle(@Param('id') id: string) {
    this.validateId(id);
    await this.markets.triggerSettle(id);
    this.activity.recordAdminAction({ action: 'settle', targetContractId: id, result: 'ok' });
    return this.markets.get(id);
  }

  @Post(':id/cancel')
  @UseGuards(AdminGuard)
  @HttpCode(200)
  async cancel(@Param('id') id: string) {
    this.validateId(id);
    await this.markets.triggerCancel(id);
    this.activity.recordAdminAction({ action: 'cancel', targetContractId: id, result: 'ok' });
    return this.markets.get(id);
  }
}
