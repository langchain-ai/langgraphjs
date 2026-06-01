import { expect, it } from "vitest";

import BasicStream from "./components/BasicStream.svelte";
import Branching from "./components/Branching.svelte";
import ContextChild from "./components/ContextChild.svelte";
import ContextControls from "./components/ContextControls.svelte";
import ContextMessageList from "./components/ContextMessageList.svelte";
import ContextOrphan from "./components/ContextOrphan.svelte";
import ContextParent from "./components/ContextParent.svelte";
import ContextProvider from "./components/ContextProvider.svelte";
import CustomStreamMethods from "./components/CustomStreamMethods.svelte";
import CustomTransportStream from "./components/CustomTransportStream.svelte";
import CustomTransportStreamSubgraphs from "./components/CustomTransportStreamSubgraphs.svelte";
import DeepAgentSubscriptionStream from "./components/DeepAgentSubscriptionStream.svelte";
import DeepAgentStream from "./components/DeepAgentStream.svelte";
import HeadlessToolStream from "./components/HeadlessToolStream.svelte";
import HistoryMessages from "./components/HistoryMessages.svelte";
import InitialValuesStream from "./components/InitialValuesStream.svelte";
import InterruptsArray from "./components/InterruptsArray.svelte";
import InterruptStream from "./components/InterruptStream.svelte";
import MessageMetadataStream from "./components/MessageMetadataStream.svelte";
import MessageRemoval from "./components/MessageRemoval.svelte";
import MultiSubmit from "./components/MultiSubmit.svelte";
import NewThreadId from "./components/NewThreadId.svelte";
import OnRequest from "./components/OnRequest.svelte";
import OnStopCallback from "./components/OnStopCallback.svelte";
import QueueOnCreated from "./components/QueueOnCreated.svelte";
import QueueStream from "./components/QueueStream.svelte";
import ReattachSecondaryStream from "./components/ReattachSecondaryStream.svelte";
import ReattachStream from "./components/ReattachStream.svelte";
import RetainedSubagentStream from "./components/RetainedSubagentStream.svelte";
import RootSelectorsStream from "./components/RootSelectorsStream.svelte";
import StopFunctionalStream from "./components/StopFunctionalStream.svelte";
import StopMutateStream from "./components/StopMutateStream.svelte";
import StreamContextChild from "./components/StreamContextChild.svelte";
import StreamContextOrphan from "./components/StreamContextOrphan.svelte";
import StreamContextParent from "./components/StreamContextParent.svelte";
import SubgraphStream from "./components/SubgraphStream.svelte";
import SubscriptionRootMessages from "./components/SubscriptionRootMessages.svelte";
import SubscriptionScopedMessages from "./components/SubscriptionScopedMessages.svelte";
import SubscriptionScopedToolCalls from "./components/SubscriptionScopedToolCalls.svelte";
import SubmitOnError from "./components/SubmitOnError.svelte";
import SubmitThreadIdOverride from "./components/SubmitThreadIdOverride.svelte";
import SwitchThread from "./components/SwitchThread.svelte";
import SwitchThreadStream from "./components/SwitchThreadStream.svelte";
import ToolCallsStream from "./components/ToolCallsStream.svelte";

const components = [
  BasicStream,
  Branching,
  ContextChild,
  ContextControls,
  ContextMessageList,
  ContextOrphan,
  ContextParent,
  ContextProvider,
  CustomStreamMethods,
  CustomTransportStream,
  CustomTransportStreamSubgraphs,
  DeepAgentSubscriptionStream,
  DeepAgentStream,
  HeadlessToolStream,
  HistoryMessages,
  InitialValuesStream,
  InterruptsArray,
  InterruptStream,
  MessageMetadataStream,
  MessageRemoval,
  MultiSubmit,
  NewThreadId,
  OnRequest,
  OnStopCallback,
  QueueOnCreated,
  QueueStream,
  ReattachSecondaryStream,
  ReattachStream,
  RetainedSubagentStream,
  RootSelectorsStream,
  StopFunctionalStream,
  StopMutateStream,
  StreamContextChild,
  StreamContextOrphan,
  StreamContextParent,
  SubgraphStream,
  SubscriptionRootMessages,
  SubscriptionScopedMessages,
  SubscriptionScopedToolCalls,
  SubmitOnError,
  SubmitThreadIdOverride,
  SwitchThread,
  SwitchThreadStream,
  ToolCallsStream,
];

it("compiles all Svelte test components against the public SDK surface", () => {
  expect(components).toHaveLength(44);
});
