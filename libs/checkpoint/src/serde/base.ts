export interface SerializerProtocol {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dumpsTyped(data: any): [string, Uint8Array];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  loadsTyped(type: string, data: Uint8Array | string): any;
}
