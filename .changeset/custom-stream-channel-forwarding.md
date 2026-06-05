---
"@langchain/langgraph": patch
"@langchain/langgraph-api": patch
---

fix(langgraph): forward named custom stream channels consistently

Forward remote `StreamChannel` emissions as `custom:<name>` protocol events and normalize them back to custom-channel payloads in the API session. This aligns JavaScript stream-channel forwarding with the protocol subscription shape used by remote clients, so `custom:<name>` subscriptions receive extension channel data consistently.
