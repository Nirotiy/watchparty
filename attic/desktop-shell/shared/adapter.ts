import type { DomainEvent, ProductId } from "./domain"

export interface ProductAdapter {
  readonly product: ProductId
  connect(): Promise<void>
  disconnect(): Promise<void>
  redeemInvite(code: string): Promise<unknown>
  subscribe(listener: (event: DomainEvent) => void): () => void
}
