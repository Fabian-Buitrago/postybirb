const path = require('path');
const url = require('url');
const fs = require('fs-extra');
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  powerSaveBlocker,
} = require('electron');
const log = require('electron-log');
const template = require('./src/electron-menu');
const autoUpdater = require('./src/auto-updater');
const windowStateKeeper = require('electron-window-state');

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
  return;
}

// Weasyl fix
app.commandLine.appendSwitch('disable-features', 'CrossOriginOpenerPolicy');

app.on('second-instance', () => {
  if (win) {
    win.closeAfterPost = false;
    if (win.isMinimized()) {
      win.restore();
    } else {
      win.show();
    }
    win.focus();
  } else {
    initialize();
  }

  clearScheduleCheck();
});

require('electron-context-menu')({
  showInspectElement: false,
});

log.info('Starting PostyBirb...');

let win = null; // Primary App BrowserWindow
let mainWindowState = null;
let scheduleCheckInterval = null; // Interval for checking for scheduled posts when app is in a closed state
let cacheClearInterval = null; // Interval for manually clearing cache
const userDataPath = app.getPath('userData');
const dataPath = path.join(userDataPath, 'data');

const devMode = !!process.argv.find(arg => arg === '-d' || arg === '--develop');

if (devMode) {
  console.log('DataPath', dataPath);
}

const blockerId = powerSaveBlocker.start('prevent-app-suspension');

// Create/check for profile file
fs.ensureFileSync(path.join(dataPath, 'profiles.json'));
fs.ensureFileSync(path.join(dataPath, 'templates.json'));
fs.ensureFileSync(path.join(dataPath, 'description-templates.json'));
fs.ensureFileSync(path.join(dataPath, 'tag-templates.json'));
fs.ensureFileSync(path.join(dataPath, 'settings.json'));
fs.ensureFileSync(path.join(dataPath, 'scheduled-submissions.json'));

let settings = {
  hardwareAcceleration: true
};

try {
  settings = fs.readJsonSync(path.join(dataPath, 'settings.json'));
} catch (e) {
  // Ignorable - should only ever throw on empty settings file
}

if (settings) {
  if (process.platform === 'win32' || process.platform === 'darwin') {
    if (settings.hardwareAcceleration === false) {
      app.disableHardwareAcceleration();
      log.info('Hardware Acceleration is off');
    }
  } else { // Always disable on Linux or other unknown OS
    app.disableHardwareAcceleration();
    log.info('Hardware Acceleration is off - Disabled on Linux');
  }
} else {
  // No settings, just assume to turn off acceleration
  app.disableHardwareAcceleration();
  log.info('Hardware Acceleration is off');
}

// Enable windows 10 notifications
if (process.platform === 'win32') {
  app.setAppUserModelId('com.lemonynade.postybirb');
}

app.on('ready', () => {
  app.userAgentFallback = app.userAgentFallback.replace(/Electron.*?\s/, ''); // EXPERIMENTAL: Attempt to get Google Sign-In working
  log.info('PostyBirb Ready...');

  // Set Menu Items
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);

  // Set Application Icon
  let image = nativeImage.createFromPath(path.join(__dirname, '/dist/assets/icon/minnowicon.png'));
  if (process.platform === 'darwin') {
    image = image.resize({
      width: 16,
      height: 16,
    });
  }
  // image.setTemplateImage(true);

  const trayItems = [{
    label: 'Open',
    click() {
      clearScheduleCheck();
      createOrInitializeWindow();
    },
  }, {
    label: 'Quit',
    click() {
      try { // Potential to throw error if not initialized intervals
        clearInterval(cacheClearInterval);
        clearScheduleCheck();
        powerSaveBlocker.stop(blockerId);
      } catch (e) {
        // Don't Care
      } finally {
        app.quit();
      }
    },
  }];

  global.tray = new Tray(image);
  const trayMenu = Menu.buildFromTemplate(trayItems);

  tray.setContextMenu(trayMenu);
  tray.setToolTip('PostyBirb');
  tray.on('click', () => {
    createOrInitializeWindow();
    clearScheduleCheck();
  });

  if (!devMode) {
    autoUpdater.autoUpdater.checkForUpdates();
    start();
  } else {
    start();
  }
});

function start() {
  if (!settings.startAsTaskbar) {
    createOrInitializeWindow();
  } else {
    hasScheduled(); // start timers
  }
}

function createOrInitializeWindow() {
  if (!hasWindows()) {
    initialize();
  } else {
    win.closeAfterPost = false;
    if (win.isMinimized()) {
      win.restore();
    } else {
      win.show();
    }
    win.focus();
  }
}

/**
 * Initializes Application Window
 * @param  {Boolean} [show=true] If the application will be visible
 */
function initialize(show = true) {
  if (!mainWindowState) {
    mainWindowState = windowStateKeeper({
      defaultWidth: 992,
      defaultHeight: 800,
    });
  }

  win = new BrowserWindow({
    show,
    width: mainWindowState.width,
    minWidth: 500,
    height: mainWindowState.height,
    minHeight: 500,
    autoHideMenuBar: true,
    icon: path.join(__dirname, '/dist/assets/icon/minnowicon.png'),
    title: 'PostyBirb',
    webPreferences: {
      devTools: devMode,
      allowRunningInsecureContent: false,
      nodeIntegration: false,
      preload: path.join(__dirname, 'dist', 'electron-src', 'index.js'),
      webviewTag: true,
      backgroundThrottling: false,
      contextIsolation: false,
      spellcheck: true,
      enableRemoteModule: true,
      navigateOnDragDrop: true // needed for drop of files
    },
  });

  win.closeAfterPost = !show;

  if (!devMode) mainWindowState.manage(win);
  if (devMode) {
    win.webContents.openDevTools();
  }

  win.webContents.session.clearCache(() => {
    log.info('Cache cleared')
  });
  win.loadURL(url.format({
    pathname: path.join(__dirname, 'dist', 'index.html'),
    protocol: 'file:',
    slashes: true,
  }));

  win.on('page-title-updated', e => e.preventDefault()); // Do not allow title changes

  win.webContents.on('new-window', (event) => {
    event.preventDefault();
  });

  win.on('closed', () => {
    clearInterval(cacheClearInterval);
    win = null;
    // Destroy any lingering window (hopefully not the update window)
    BrowserWindow.getAllWindows().forEach(w => {
      w.destroy();
    });
  });

  win.webContents.once('did-frame-finish-load', () => {
    cacheClearInterval = setInterval(() => {
      win.webContents.session.clearCache(() => {});
    }, 60000);
  });

  win.webContents.once('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    log.error(`${errorDescription} (${errorCode}): ${validatedURL}`);
  });
}

/**
 * Application and Process Events
 */

app.on('uncaughtException', (err) => {
  log.error(err);
});

process.on('uncaughtException', (err) => {
  log.error(err);
});

app.on('window-all-closed', () => {
  attemptToClose();
});

function hasWindows() {
  return win !== null;
}

function clearScheduleCheck() {
  log.info('Cancelling schedule check...');
  clearInterval(scheduleCheckInterval);
}

function hasScheduled() {
  // NOTE: There is a small chance this could become stale in a relaunch + scheduled case
  const data = fs.readJsonSync(path.join(dataPath, 'scheduled-submissions.json'));
  if (data && data.scheduled && data.scheduled.length) {
    scheduleCheckInterval = setInterval(() => {
      log.info('Checking for scheduled submissions...');
      // Guard against any race behavior
      if (hasWindows()) {
        log.info('Window detected as open: Ceasing...')
        clearInterval(scheduleCheckInterval);
        return;
      }

      const now = Date.now();
      for (let i = 0; i < data.scheduled.length; i++) {
        if (data.scheduled[i] <= now) {
          log.info('Opening window to perform post');
          initialize(false);
          clearInterval(scheduleCheckInterval);
          break;
        }
      }
    }, 15000);
    return true;
  }

  return false;
}

/**
 * Close or send app to tray
 */
function attemptToClose() {
  let scheduled = false;
  try {
    scheduled = hasScheduled();
  } catch (e) {
    /* should be ignorable */
  }
  if (!scheduled) {
    clearInterval(scheduleCheckInterval);
    powerSaveBlocker.stop(blockerId);
    app.quit();
  }
}
