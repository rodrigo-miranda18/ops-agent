export interface CommunicationVersionEvents {
  versionReady(input: {
    communicationId: string;
    version: number;
  }): Promise<void>;
  versionFailed(input: {
    communicationId: string;
    version: number;
    error: string;
  }): Promise<void>;
}

export const COMMUNICATION_VERSION_EVENTS = Symbol(
  'COMMUNICATION_VERSION_EVENTS',
);
