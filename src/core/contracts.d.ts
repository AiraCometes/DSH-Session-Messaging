/** Extension contracts for v1 messages and adapters. Runtime validation remains mandatory. */
export type SessionRole = 'tower' | 'spec' | 'implementation' | 'review' | 'integration';
export type MessageStatus = 'queued' | 'delivering' | 'accepted' | 'processing' | 'completed' | 'failed' | 'uncertain';
export interface SessionBinding {
  id: string;
  role: SessionRole;
  adapter: string;
  address: string;
  /** Configured model label. Actual model provisioning is the host's responsibility. */
  model: string;
  provider: string;
}
export interface TowerMessage {
  id: string;
  threadId: string;
  from: string;
  to: string;
  body: string;
  taskId: string | null;
  replyTo: string | null;
  sender: SessionBinding;
  recipient: SessionBinding;
  status: MessageStatus;
  attempts: number;
  createdAt: string;
  updatedAt?: string;
  receiptId?: string;
  error?: string | null;
}
export interface DeliveryAdapter {
  /** Return only after target inbox admission. Deduplicate by message.id when crossing a network. */
  deliver(message: TowerMessage): Promise<{ id: string }>;
}
export interface TowerEvent<T = unknown> {
  seq: number;
  version: 1;
  type: string;
  time: string;
  data: T;
}
