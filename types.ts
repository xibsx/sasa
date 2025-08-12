
export enum BotStatus {
  RUNNING = 'RUNNING',
  STOPPED = 'STOPPED',
  STARTING = 'STARTING',
  STOPPING = 'STOPPING',
  QR_NEEDED = 'QR_NEEDED',
  FAILED = 'FAILED',
  PENDING_SETUP = 'PENDING_SETUP',
}

export interface Client {
  id: string;
  name: string;
  avatarUrl?: string;
  phone?: string;
  connectedAt?: string;
  status: BotStatus;
}

export type PhoneAuthState = 'phone_input' | 'phone_loading' | 'phone_displaying' | 'phone_expired';