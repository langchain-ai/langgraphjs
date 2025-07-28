export interface SerializerProtocol {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dumpsTyped(data: any): Promise<[string, Uint8Array]>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  loadsTyped(type: string, data: Uint8Array | string): Promise<any>;
}
