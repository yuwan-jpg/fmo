import type { Platform } from '../index'
import { webCapabilities } from './Capabilities.web'
import { WebGridService } from './GridService.web'
import { WebAprsService } from './AprsService.web'
import { WebAudioService } from './AudioService.web'
import { WebBackgroundService } from './BackgroundService.web'
import { WebEventsService } from './EventsService.web'
import { WebLocationService } from './LocationService.web'
import { WebStorageService } from './StorageService.web'
import { WebRecordingService } from './RecordingService.web'

export function createWebPlatform(): Platform {
  const audio = new WebAudioService()
  return {
    events: new WebEventsService(),
    audio,
    aprs: new WebAprsService(),
    grid: new WebGridService(),
    background: new WebBackgroundService(),
    location: new WebLocationService(),
    recording: new WebRecordingService(audio),
    storage: new WebStorageService(),
    capabilities: webCapabilities
  }
}
