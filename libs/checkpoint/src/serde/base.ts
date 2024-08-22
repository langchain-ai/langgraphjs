import { load } from "@langchain/core/load";

export interface SerializerProtocol<D> {
  stringify(obj: D): string;
  parse(data: string): Promise<D>;
}

export const DefaultSerializer = {
  stringify: JSON.stringify,
  parse: load,
};
