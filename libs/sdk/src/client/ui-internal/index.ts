import { BaseClient } from "../base.js";

export class UiClient extends BaseClient {
  private static promiseCache: Record<string, Promise<unknown> | undefined> =
    {};

  private static getOrCached<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (UiClient.promiseCache[key] != null) {
      return UiClient.promiseCache[key] as Promise<T>;
    }

    const promise = fn();
    UiClient.promiseCache[key] = promise;
    return promise;
  }

  async getComponent(assistantId: string, agentName: string): Promise<string> {
    return UiClient.getOrCached(
      `${this.apiUrl}-${assistantId}-${agentName}`,
      async () => {
        // oxlint-disable-next-line prefer-const -- init is reassigned by onRequest hook
        let [url, init] = this.prepareFetchOptions(`/ui/${assistantId}`, {
          headers: {
            Accept: "text/html",
            "Content-Type": "application/json",
          },
          method: "POST",
          json: { name: agentName },
        });
        if (this.onRequest != null) init = await this.onRequest(url, init);

        const response = await this.asyncCaller.fetch(url.toString(), init);
        return response.text();
      }
    );
  }
}
