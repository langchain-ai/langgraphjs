// eslint-disable-next-line import/no-extraneous-dependencies
import { specTest } from "../spec/index.js";
import { initializer } from "./sqliteInitializer.js";

specTest(initializer);
