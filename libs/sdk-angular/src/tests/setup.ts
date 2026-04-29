import "@angular/compiler";
import { NgModule, provideZonelessChangeDetection } from "@angular/core";
import {
  ɵgetCleanupHook as getCleanupHook,
  getTestBed,
} from "@angular/core/testing";
import {
  BrowserTestingModule,
  platformBrowserTesting,
} from "@angular/platform-browser/testing";
import { afterEach, beforeEach } from "vitest";

const ANGULAR_TESTBED_SETUP = Symbol.for("testbed-setup");

beforeEach(getCleanupHook(false));
afterEach(getCleanupHook(true));

@NgModule({
  providers: [provideZonelessChangeDetection()],
})
class TestModule {}

if (!globalThis[ANGULAR_TESTBED_SETUP as keyof typeof globalThis]) {
  Object.defineProperty(globalThis, ANGULAR_TESTBED_SETUP, {
    value: true,
    configurable: true,
  });

  getTestBed().initTestEnvironment(
    [BrowserTestingModule, TestModule],
    platformBrowserTesting(),
    {
      teardown: { destroyAfterEach: false },
    }
  );
}
