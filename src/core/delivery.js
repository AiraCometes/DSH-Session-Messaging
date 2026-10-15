/** Only throw this when the adapter KNOWS the destination did not accept input. */
export class DeliveryRejected extends Error {
  constructor(message) { super(message); this.name = 'DeliveryRejected'; }
}
