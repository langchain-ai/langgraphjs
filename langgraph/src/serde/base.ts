export interface SerializerProtocol<D> {
  stringify(obj: D): string;
  parse(data: string): D;
}
