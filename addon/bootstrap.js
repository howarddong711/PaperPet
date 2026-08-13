var paperPetRuntime;
var paperPetPreferencePaneID;

function log(message) {
  Zotero.debug(`[PaperPet] ${message}`);
}

function install() {
  log("Installed");
}

async function startup({ id, rootURI }) {
  log("Starting");

  paperPetPreferencePaneID = await Zotero.PreferencePanes.register({
    pluginID: id,
    id: "paperpet",
    label: "PaperPet",
    image: `${rootURI}content/paperpet-icon.png`,
    src: `${rootURI}content/settings/paperpet-preferences.xhtml`,
    scripts: [`${rootURI}content/scripts/paperpet-preferences.js`],
    stylesheets: [`${rootURI}content/paperpet-preferences.css`],
    defaultXUL: true,
  });

  const context = {
    Cc,
    Ci,
    IOUtils,
    PathUtils,
    Services,
    Zotero,
    rootURI,
  };
  context._globalThis = context;

  Services.scriptloader.loadSubScript(
    `${rootURI}content/scripts/paperpet.js`,
    context,
  );

  paperPetRuntime = context.PaperPetRuntime;
  await paperPetRuntime.startup();
}

async function onMainWindowLoad({ window }) {
  await paperPetRuntime?.addToWindow(window);
}

async function onMainWindowUnload({ window }) {
  paperPetRuntime?.removeFromWindow(window);
}

async function shutdown(_data, reason) {
  log(
    reason === APP_SHUTDOWN
      ? "Saving before application shutdown"
      : "Shutting down",
  );
  await paperPetRuntime?.shutdown();
  if (paperPetPreferencePaneID) {
    Zotero.PreferencePanes.unregister(paperPetPreferencePaneID);
    paperPetPreferencePaneID = undefined;
  }
  paperPetRuntime = undefined;
}

function uninstall() {
  log("Uninstalled");
}
