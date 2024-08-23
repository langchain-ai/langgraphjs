export interface SerializerProtocol {
  dumpsTyped(data: any): [string, Uint8Array];
  loadsTyped(type: string, data: Uint8Array | string): Promise<any>;
}
