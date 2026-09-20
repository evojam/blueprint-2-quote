import type { EntityManager } from '@mikro-orm/postgresql'
import {
  CustomerDeal,
  CustomerPipelineStage,
} from '@open-mercato/core/modules/customers/data/entities'
import {
  TERMINAL_PIPELINE_STAGE_LABELS,
  normalizePipelineStageLabel,
} from '@open-mercato/core/modules/customers/lib/closureStage'
import type { CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { runCommand } from './commandBus'
import { loadRfqFunnel, rfqStageIndex, type RfqStageKey, type Scope } from './pipeline'
import { resolveCaseId } from './quoteCase'

const logger = createLogger('rfq_intake').child({ component: 'quote-sent-funnel' })

/**
 * Where a case stands right now, reduced to the two things the decision needs.
 *
 * `rfqStageKey` is `null` for a stage that is not part of the RFQ funnel — a deal still
 * parked in the stock `Default Pipeline`, which is the normal state on an environment
 * where `mercato rfq_intake seed-pipeline` has not run.
 */
export type CurrentStage = {
  rfqStageKey: RfqStageKey | null
  label: string | null
}

export type AdvanceOutcome =
  | 'moved'
  | 'not-an-rfq-case'
  | 'case-not-visible'
  | 'funnel-not-seeded'
  | 'already-at-or-past-sent'
  | 'case-is-closed'

function isTerminalLabel(label: string | null): boolean {
  if (!label) return false
  const normalized = normalizePipelineStageLabel(label)
  return (
    TERMINAL_PIPELINE_STAGE_LABELS.won.has(normalized)
    || TERMINAL_PIPELINE_STAGE_LABELS.lost.has(normalized)
  )
}

/**
 * The direction guard: may a sent quote move this case to `Oferta wysłana`?
 *
 * Pure, and separated from every database read on purpose — this is the rule the feature
 * is actually about, and it is the part worth pinning with tests that cannot drift with
 * a schema.
 *
 * | Current stage | Moves? |
 * |---|---|
 * | none | yes — the case has not entered a funnel |
 * | an RFQ stage before `sent` | yes |
 * | an RFQ stage at or after `sent` | no — re-sending must not re-announce |
 * | a label reading won/lost in ANY pipeline | no — closing beats sending |
 * | a foreign, non-terminal stage | yes — the case enters the RFQ funnel |
 *
 * The terminal check runs FIRST and is label-based rather than key-based, so it also
 * catches a deal closed in a pipeline this module knows nothing about. `Closed Won` and
 * `Closed Lost` in `RFQ_PIPELINE_STAGES` are English precisely so they match the
 * installed `TERMINAL_PIPELINE_STAGE_LABELS` set — the same reason recorded there.
 *
 * The last row is a deliberate choice: pulling a deal out of the stock `Default Pipeline`
 * and into the RFQ funnel on send is the intended behaviour, and the terminal check above
 * is what stops it from dragging a finished deal backwards.
 */
export function shouldAdvanceToSent(current: CurrentStage | null): boolean {
  if (!current) return true
  if (isTerminalLabel(current.label)) return false
  if (current.rfqStageKey === null) return true
  return rfqStageIndex(current.rfqStageKey) < rfqStageIndex('sent')
}

/**
 * Moves the case a just-sent quote answers to `Oferta wysłana`, if the guard allows it.
 *
 * Every early return is a normal outcome, not an error: most quotes in the system were
 * never priced from an RFQ. The caller treats the whole thing as best-effort — the
 * customer already has the e-mail by the time this runs, so nothing here may turn a
 * completed send into a failure.
 *
 * The actual write goes through `rfq_intake.deal.advance` rather than setting
 * `pipelineStageId` here, so the transition lands in the deal's history exactly the way a
 * workflow-driven move does. That command resolves the funnel a second time; the extra
 * read is the price of keeping one write path, on an operation that happens once per
 * quote.
 */
export async function advanceCaseForSentQuote(
  ctx: CommandRuntimeContext,
  input: { quoteId: string; scope: Scope },
): Promise<AdvanceOutcome> {
  const em = (ctx.container.resolve('em') as EntityManager).fork()
  const { quoteId, scope } = input

  const resolved = await resolveCaseId(em, scope, quoteId)
  if (!resolved) {
    logger.debug('Sent quote is not linked to an RFQ case; leaving the funnel alone', { quoteId })
    return 'not-an-rfq-case'
  }

  const deal = await em.findOne(CustomerDeal, { id: resolved.dealId, ...scope, deletedAt: null })
  if (!deal) {
    logger.warn('Sent quote names a case that is not visible in this scope', {
      quoteId,
      dealId: resolved.dealId,
    })
    return 'case-not-visible'
  }

  const funnel = await loadRfqFunnel(em, scope)
  if (!funnel) {
    // The deployed-environment failure mode, and the reason it is a warning rather than a
    // debug line: `mercato rfq_intake seed-pipeline` has never run here, so there is no
    // `Oferta wysłana` to move to and the feature looks broken with no other signal.
    logger.warn('RFQ funnel is not seeded; the sent quote cannot move its case', {
      quoteId,
      dealId: resolved.dealId,
    })
    return 'funnel-not-seeded'
  }

  const current = await loadCurrentStage(em, scope, funnel.keyByStageId, deal.pipelineStageId ?? null)
  if (!shouldAdvanceToSent(current)) {
    logger.debug('Case is already at or past the sent stage, or closed; not moving it', {
      quoteId,
      dealId: resolved.dealId,
      stageKey: current?.rfqStageKey ?? null,
    })
    return isTerminalLabel(current?.label ?? null) ? 'case-is-closed' : 'already-at-or-past-sent'
  }

  await runCommand(ctx, 'rfq_intake.deal.advance', {
    ...scope,
    dealId: resolved.dealId,
    stage: 'sent' satisfies RfqStageKey,
  })

  logger.info('RFQ case moved to the sent stage by its quote', {
    quoteId,
    dealId: resolved.dealId,
    from: current?.rfqStageKey ?? null,
  })
  return 'moved'
}

/**
 * Reads the stage a deal currently sits in, mapped onto the RFQ funnel where possible.
 *
 * Decryption-aware because stage labels are an encryption candidate and the terminal
 * check compares that label — reading it raw would compare ciphertext and silently let a
 * closed deal be dragged backwards on an encrypted tenant.
 */
async function loadCurrentStage(
  em: EntityManager,
  scope: Scope,
  keyByStageId: Map<string, RfqStageKey>,
  pipelineStageId: string | null,
): Promise<CurrentStage | null> {
  if (!pipelineStageId) return null
  const stage = await findOneWithDecryption(
    em,
    CustomerPipelineStage,
    { id: pipelineStageId, ...scope },
    {},
    scope,
  )
  if (!stage) return null
  return {
    rfqStageKey: keyByStageId.get(stage.id) ?? null,
    label: stage.label ?? null,
  }
}
