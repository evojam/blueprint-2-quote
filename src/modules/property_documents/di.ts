import { asValue } from 'awilix'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import './ai-agents'
import { ROOM_DIMENSIONS_VISION_SERVICE } from './ai-tools'
import { roomDimensionsVisionService } from './room-dimensions-vision'
import { registerLiteLlmChatProvider } from './litellm-provider'

export function register(container: AppContainer): void {
  registerLiteLlmChatProvider()

  container.register({
    [ROOM_DIMENSIONS_VISION_SERVICE]: asValue(roomDimensionsVisionService),
  })
}
