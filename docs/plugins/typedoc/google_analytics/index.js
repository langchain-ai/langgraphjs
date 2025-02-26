// @ts-check
import { Application, JSX, ParameterType } from "typedoc";
import fs from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @param {Application} app */
function _addGaOptionsParameter(app) {
  app.options.addDeclaration({
    name: 'gtmId',
    help: 'Set the Google Analytics tracking ID and activate tracking code',
    type: ParameterType.String
  });
}

function loadGaInitScript(gaID) {
  try {
    const script = fs.readFileSync(__dirname + "/client_script.js", "utf8");
    return (script || "// No script found").replaceAll("${gaID}", gaID);
  } catch (e) {
    console.error(e);
    return e.toString().split("\n").map(l => '// ' + l).join('\n');
  }
}


function _addGtmScript(app) {
  app.renderer.hooks.on("head.end", () => {
    const gtmId = app.options.getValue("gtmId");
    if (gtmId) {
      const initScriptContent = loadGaInitScript(gtmId);
      return JSX.createElement(
        "script",
        {},
        JSX.createElement(JSX.Raw, { html: initScriptContent })
      );
    }
    return JSX.createElement(JSX.Fragment, null);
  });
}

/** @param {Application} app */
export function load(app) {
  _addGaOptionsParameter(app);
  _addGtmScript(app);
} 