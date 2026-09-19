import type { CommandRuntimeContext } from '@open-mercato/shared/lib/commands'

type CommandBusLike = {
  execute: <TInput, TResult>(
    commandId: string,
    options: { input: TInput; ctx: CommandRuntimeContext },
  ) => Promise<{ result: TResult }>
}

/**
 * Calls another command from inside a command handler.
 *
 * Wrapped because `CommandBus.execute` takes an options object, not a bare payload,
 * and returns `{ result, logEntry }` rather than the handler's own return value — two
 * details easy to get wrong when the bus is resolved out of the container untyped. The
 * caller's `ctx` is forwarded so the actor, the tenant guard and the audit log entry
 * stay attached to the nested write.
 */
export async function runCommand<TInput, TResult>(
  ctx: CommandRuntimeContext,
  commandId: string,
  input: TInput,
): Promise<TResult> {
  const bus = ctx.container.resolve('commandBus') as CommandBusLike
  const { result } = await bus.execute<TInput, TResult>(commandId, { input, ctx })
  return result
}
