import { createModuleEvents } from '@open-mercato/shared/modules/events'

/**
 * RFQ Intake events.
 *
 * `inbox_ops.action.executed` carries no attachments, and a workflow trigger's
 * `contextMapping` can only read the event payload — so this module emits its own
 * event, already shaped as the agent's input envelope. It is also the seam the
 * later pricing and offer stages hang off.
 */
const events = [
  { id: 'rfq_intake.rfq.created', label: 'RFQ Created', entity: 'rfq', category: 'custom' },
] as const

export const eventsConfig = createModuleEvents({ moduleId: 'rfq_intake', events })

export const emitRfqIntakeEvent = eventsConfig.emit

export type RfqIntakeEventId = typeof events[number]['id']

export default eventsConfig
