// import { type RunnableConfig } from "@langchain/core/runnables";
// import {
//   BaseCheckpointSaver,
//   Checkpoint,
//   CheckpointMetadata,
// } from "../checkpoint/base.js";
// import { BaseChannel } from "../channels/base.js";
// import {
//   PendingWrite,
//   CheckpointPendingWrite,
//   PregelExecutableTask,
// } from "./types.js";
// import { CONFIG_KEY_READ } from "../constants.js";
// import { _applyWrites } from "./algo.js";

// const INPUT_DONE = Symbol.for("INPUT_DONE");
// const INPUT_RESUMING = Symbol.for("INPUT_RESUMING");

// export type PregelLoopParams = {
//   input?: any;
//   config: RunnableConfig;
//   checkpointer?: BaseCheckpointSaver;
//   graph: any;
// };

// export class PregelLoop {
//   protected input?: any;
//   protected config: RunnableConfig;
//   protected checkpointer?: BaseCheckpointSaver;
//   protected checkpointerGetNextVersion: (checkpoint: any) => any;
//   protected _checkpointerPutAfterPrevious?: (input: {
//     config: RunnableConfig;
//   }) => any;
//   // TODO: Fix typing
//   protected graph: any;
//   // protected submit: Submit;
//   protected channels: Record<string, BaseChannel>;
//   // TODO: Fix typing
//   protected managed: Record<string, any>;
//   protected checkpoint?: Checkpoint;
//   protected checkpointConfig: RunnableConfig;
//   protected checkpointMetadata: CheckpointMetadata;
//   protected checkpointPendingWrites: CheckpointPendingWrite[] = [];
//   protected checkpointPreviousVersions: Record<string, string | number>;
//   protected step: number;
//   protected stop: number;
//   protected status:
//     | "pending"
//     | "done"
//     | "interrupt_before"
//     | "interrupt_after"
//     | "out_of_steps";
//   protected tasks: PregelExecutableTask<string, string>[];
//   protected stream: [string, any][] = [];
//   protected isNested: boolean;

//   constructor(params: PregelLoopParams) {
//     this.input = params.input;
//     this.config = params.config;
//     this.checkpointer = params.checkpointer;
//     this.graph = params.graph;
//     this.isNested = CONFIG_KEY_READ in (this.config.configurable ?? {});
//   }

//   /**
//    * Put writes for a task, to be read by the next tick.
//    * @param taskId
//    * @param writes
//    */
//   putWrites(taskId: string, writes: PendingWrite<string>[]) {
//     const pendingWrites: CheckpointPendingWrite<string>[] = writes.map(
//       ([key, value]) => {
//         return [taskId, key, value];
//       }
//     );
//     this.checkpointPendingWrites.push(...pendingWrites);
//     if (this.checkpoint === undefined) {
//       throw new Error(
//         "Putting writes failed: Pregel loop has no current checkpoint."
//       );
//     }
//     if (this.checkpointer !== undefined) {
//       void this.checkpointer.putWrites(
//         {
//           ...this.checkpointConfig,
//           configurable: {
//             ...this.checkpointConfig.configurable,
//             checkpoint_ns: this.config.configurable?.checkpoint_ns ?? "",
//             checkpoint_id: this.checkpoint.id,
//           },
//         },
//         writes,
//         taskId
//       );
//     }
//   }

//   /**
//    * Execute a single iteration of the Pregel loop.
//    * Returns true if more iterations are needed.
//    * @param params
//    */
//   async tick(params: {
//     outputKeys: string | string[];
//     interruptAfter: string[];
//     interruptBefore: string[];
//     manager?: any;
//   }): Promise<boolean> {
//     const {
//       outputKeys = [],
//       interruptAfter = [],
//       interruptBefore = [],
//       manager,
//     } = params;
//     if (this.status !== "pending") {
//       throw new Error(
//         `Cannot tick when status is no longer "pending". Current status: "${this.status}"`
//       );
//     }
//     if (this.checkpoint === undefined) {
//       throw new Error("Tick failed: Pregel loop has no current checkpoint.");
//     }
//     if (![INPUT_DONE, INPUT_RESUMING].includes(this.input)) {
//       await this._first();
//     } else if (this.tasks.every((task) => task.writes.length > 0)) {
//       const writes = this.tasks.flatMap((t) => t.writes);
//       // All tasks have finished
//       _applyWrites(this.checkpoint, this.channels, this.tasks);
//     }
//   }

//   /**
//    * Resuming from previous checkpoint requires
//    * - finding a previous checkpoint
//    * - receiving None input (outer graph) or RESUMING flag (subgraph)
//    */
//   protected async _first() {}
// }
// //         elif all(task.writes for task in self.tasks):
// //             writes = [w for t in self.tasks for w in t.writes]
// //             # all tasks have finished
// //             apply_writes(
// //                 self.checkpoint,
// //                 self.channels,
// //                 self.tasks,
// //                 self.checkpointer_get_next_version,
// //             )
// //             # produce values output
// //             self.stream.extend(
// //                 ("values", v)
// //                 for v in map_output_values(output_keys, writes, self.channels)
// //             )
// //             # clear pending writes
// //             self.checkpoint_pending_writes.clear()
// //             # save checkpoint
// //             self._put_checkpoint(
// //                 {
// //                     "source": "loop",
// //                     "writes": single(
// //                         map_output_updates(output_keys, self.tasks)
// //                         if self.graph.stream_mode == "updates"
// //                         else map_output_values(output_keys, writes, self.channels)
// //                     ),
// //                 }
// //             )
// //             # after execution, check if we should interrupt
// //             if should_interrupt(self.checkpoint, interrupt_after, self.tasks):
// //                 self.status = "interrupt_after"
// //                 if self.is_nested:
// //                     raise GraphInterrupt(self)
// //                 else:
// //                     return False
// //         else:
// //             return False

// //         # check if iteration limit is reached
// //         if self.step > self.stop:
// //             self.status = "out_of_steps"
// //             return False

// //         # prepare next tasks
// //         self.tasks = prepare_next_tasks(
// //             self.checkpoint,
// //             self.graph.nodes,
// //             self.channels,
// //             self.managed,
// //             self.config,
// //             self.step,
// //             for_execution=True,
// //             manager=manager,
// //             checkpointer=self.checkpointer,
// //             is_resuming=self.input is INPUT_RESUMING,
// //         )

// //         # if no more tasks, we're done
// //         if not self.tasks:
// //             self.status = "done"
// //             return False

// //         # if there are pending writes from a previous loop, apply them
// //         if self.checkpoint_pending_writes:
// //             for tid, k, v in self.checkpoint_pending_writes:
// //                 if task := next((t for t in self.tasks if t.id == tid), None):
// //                     task.writes.append((k, v))

// //         # if all tasks have finished, re-tick
// //         if all(task.writes for task in self.tasks):
// //             return self.tick(
// //                 output_keys=output_keys,
// //                 interrupt_after=interrupt_after,
// //                 interrupt_before=interrupt_before,
// //                 manager=manager,
// //             )

// //         # before execution, check if we should interrupt
// //         if should_interrupt(self.checkpoint, interrupt_before, self.tasks):
// //             self.status = "interrupt_before"
// //             if self.is_nested:
// //                 raise GraphInterrupt()
// //             else:
// //                 return False

// //         # produce debug output
// //         self.stream.extend(("debug", v) for v in map_debug_tasks(self.step, self.tasks))

// //         return True

// //     # private

// //     def _first(self) -> None:
// //         # resuming from previous checkpoint requires
// //         # - finding a previous checkpoint
// //         # - receiving None input (outer graph) or RESUMING flag (subgraph)
// //         is_resuming = bool(self.checkpoint["channel_versions"]) and bool(
// //             self.config.get("configurable", {}).get(CONFIG_KEY_RESUMING)
// //             or self.input is None
// //         )

// //         # proceed past previous checkpoint
// //         if is_resuming:
// //             self.checkpoint["versions_seen"].setdefault(INTERRUPT, {})
// //             for k in self.channels:
// //                 if k in self.checkpoint["channel_versions"]:
// //                     version = self.checkpoint["channel_versions"][k]
// //                     self.checkpoint["versions_seen"][INTERRUPT][k] = version
// //         # map inputs to channel updates
// //         elif input_writes := deque(map_input(self.graph.input_channels, self.input)):
// //             # discard any unfinished tasks from previous checkpoint
// //             discard_tasks = prepare_next_tasks(
// //                 self.checkpoint,
// //                 self.graph.nodes,
// //                 self.channels,
// //                 self.managed,
// //                 self.config,
// //                 self.step,
// //                 for_execution=True,
// //                 manager=None,
// //             )
// //             # apply input writes
// //             apply_writes(
// //                 self.checkpoint,
// //                 self.channels,
// //                 discard_tasks + [PregelTaskWrites(INPUT, input_writes, [])],
// //                 self.checkpointer_get_next_version,
// //             )
// //             # save input checkpoint
// //             self._put_checkpoint({"source": "input", "writes": self.input})
// //         else:
// //             raise EmptyInputError(f"Received no input for {self.graph.input_channels}")
// //         # done with input
// //         self.input = INPUT_RESUMING if is_resuming else INPUT_DONE

// //     def _put_checkpoint(self, metadata: CheckpointMetadata) -> None:
// //         # assign step
// //         metadata["step"] = self.step
// //         # bail if no checkpointer
// //         if self._checkpointer_put_after_previous is not None:
// //             # create new checkpoint
// //             self.checkpoint_metadata = metadata
// //             self.checkpoint = create_checkpoint(
// //                 self.checkpoint,
// //                 self.channels,
// //                 self.step,
// //                 # child graphs keep at most one checkpoint per parent checkpoint
// //                 # this is achieved by writing child checkpoints as progress is made
// //                 # (so that error recovery / resuming from interrupt don't lose work)
// //                 # but doing so always with an id equal to that of the parent checkpoint
// //                 id=self.config["configurable"]["checkpoint_id"]
// //                 if self.is_nested
// //                 else None,
// //             )

// //             self.checkpoint_config = {
// //                 **self.checkpoint_config,
// //                 "configurable": {
// //                     **self.checkpoint_config["configurable"],
// //                     "checkpoint_ns": self.config["configurable"].get(
// //                         "checkpoint_ns", ""
// //                     ),
// //                 },
// //             }

// //             channel_versions = self.checkpoint["channel_versions"].copy()
// //             new_versions = get_new_channel_versions(
// //                 self.checkpoint_previous_versions, channel_versions
// //             )

// //             self.checkpoint_previous_versions = channel_versions

// //             # save it, without blocking
// //             # if there's a previous checkpoint save in progress, wait for it
// //             # ensuring checkpointers receive checkpoints in order
// //             self._put_checkpoint_fut = self.submit(
// //                 self._checkpointer_put_after_previous,
// //                 getattr(self, "_put_checkpoint_fut", None),
// //                 self.checkpoint_config,
// //                 copy_checkpoint(self.checkpoint),
// //                 self.checkpoint_metadata,
// //                 new_versions,
// //             )
// //             self.checkpoint_config = {
// //                 **self.checkpoint_config,
// //                 "configurable": {
// //                     **self.checkpoint_config["configurable"],
// //                     "checkpoint_id": self.checkpoint["id"],
// //                 },
// //             }
// //             # produce debug output
// //             self.stream.extend(
// //                 ("debug", v)
// //                 for v in map_debug_checkpoint(
// //                     self.step,
// //                     self.checkpoint_config,
// //                     self.channels,
// //                     self.graph.stream_channels_asis,
// //                     self.checkpoint_metadata,
// //                 )
// //             )
// //         # increment step
// //         self.step += 1

// //     def _suppress_interrupt(
// //         self,
// //         exc_type: Optional[Type[BaseException]],
// //         exc_value: Optional[BaseException],
// //         traceback: Optional[TracebackType],
// //     ) -> Optional[bool]:
// //         if exc_type is GraphInterrupt and not self.is_nested:
// //             return True

// // class SyncPregelLoop(PregelLoop, ContextManager):
// //     def __init__(
// //         self,
// //         input: Optional[Any],
// //         *,
// //         config: RunnableConfig,
// //         checkpointer: Optional[BaseCheckpointSaver],
// //         graph: "Pregel",
// //     ) -> None:
// //         super().__init__(input, config=config, checkpointer=checkpointer, graph=graph)
// //         self.stack = ExitStack()
// //         self.stack.push(self._suppress_interrupt)
// //         if checkpointer:
// //             self.checkpointer_get_next_version = checkpointer.get_next_version
// //             self.checkpointer_put_writes = checkpointer.put_writes
// //         else:
// //             self.checkpointer_get_next_version = increment
// //             self._checkpointer_put_after_previous = None
// //             self.checkpointer_put_writes = None

// //     def _checkpointer_put_after_previous(
// //         self,
// //         prev: Optional[concurrent.futures.Future],
// //         config: RunnableConfig,
// //         checkpoint: Checkpoint,
// //         metadata: CheckpointMetadata,
// //         new_versions: Optional[dict[str, Union[str, float, int]]],
// //     ) -> RunnableConfig:
// //         try:
// //             if prev is not None:
// //                 prev.result()
// //         finally:
// //             self.checkpointer.put(config, checkpoint, metadata, new_versions)

// //     # context manager

// //     def __enter__(self) -> Self:
// //         saved = (
// //             self.checkpointer.get_tuple(self.config) if self.checkpointer else None
// //         ) or CheckpointTuple(self.config, empty_checkpoint(), {"step": -2}, None, [])
// //         self.checkpoint_config = {
// //             **self.config,
// //             **saved.config,
// //             "configurable": {
// //                 **self.config.get("configurable", {}),
// //                 **saved.config.get("configurable", {}),
// //             },
// //         }
// //         self.checkpoint = copy_checkpoint(saved.checkpoint)
// //         self.checkpoint_metadata = saved.metadata
// //         self.checkpoint_pending_writes = saved.pending_writes or []

// //         self.submit = self.stack.enter_context(BackgroundExecutor(self.config))
// //         self.channels = self.stack.enter_context(
// //             ChannelsManager(self.graph.channels, self.checkpoint, self.config)
// //         )
// //         self.managed = self.stack.enter_context(
// //             ManagedValuesManager(self.graph.managed_values_dict, self.config)
// //         )
// //         self.status = "pending"
// //         self.step = self.checkpoint_metadata["step"] + 1
// //         self.stop = self.step + self.config["recursion_limit"] + 1
// //         self.checkpoint_previous_versions = self.checkpoint["channel_versions"].copy()

// //         return self

// //     def __exit__(
// //         self,
// //         exc_type: Optional[Type[BaseException]],
// //         exc_value: Optional[BaseException],
// //         traceback: Optional[TracebackType],
// //     ) -> Optional[bool]:
// //         # unwind stack
// //         del self.graph
// //         return self.stack.__exit__(exc_type, exc_value, traceback)
