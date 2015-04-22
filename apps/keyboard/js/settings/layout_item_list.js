'use strict';

/* global LayoutDictionaryList, LayoutItem */

(function(exports) {

var DownloadPreference = function(app) {
  this.app = app;
};

DownloadPreference.prototype.STATE_PROMPT = 0;
DownloadPreference.prototype.STATE_ALLOW = 1;
DownloadPreference.prototype.STATE_DENY = 2;

DownloadPreference.prototype.PREF_DOWNLOAD_ON_DATA_CONNTECION =
  'download.prompt-on-data-connection';

DownloadPreference.prototype.start = function() {
  // noop
};

DownloadPreference.prototype.stop = function() {
  // noop
};

DownloadPreference.prototype.getCurrentState = function() {
  if (!this._isUsingDataConnection()) {
    return Promise.resolve(this.STATE_ALLOW);
  }

  return this.app.preferencesStore
    .getItem(this.PREF_DOWNLOAD_ON_DATA_CONNTECION)
    .then(function(val) {
      switch (val) {
        case undefined:
          return this.STATE_PROMPT;

        case true:
          return this.STATE_ALLOW;

        case false:
          return this.STATE_DENY;

        default:
          console.error('DownloadPreference: Unknown preference.', val);
          return this.STATE_PROMPT;
      }
    }.bind(this), function(e) {
      e && console.error(e);

      return this.STATE_PROMPT;
    }.bind(this));
};

DownloadPreference.prototype.setDataConnectionDownloadState = function(state) {
  switch (state) {
    case this.STATE_PROMPT:
      return this.app.preferencesStore
        .deleteItem(this.PREF_DOWNLOAD_ON_DATA_CONNTECION);
    case this.STATE_ALLOW:
      return this.app.preferencesStore
        .setItem(this.PREF_DOWNLOAD_ON_DATA_CONNTECION, true);
    case this.STATE_DENY:
      return this.app.preferencesStore
        .setItem(this.PREF_DOWNLOAD_ON_DATA_CONNTECION, false);
    default:
      throw new Error('DownloadPreference: Unknown state.');
  }
};

DownloadPreference.prototype._isUsingDataConnection = function() {
  if (!navigator.mozMobileConnections) {
    console.warn('DownloadPreference: mozMobileConnections is not available. ' +
      'Assuming no data charges.');

    return false;
  }

  // The assumption here is that if any data connection is in connected state,
  // the connection will be the default route and we will be consuming data.
  var mobileDataConnected =
    Array.prototype.some.call(navigator.mozMobileConnections, function(conn) {
      return (conn.data && conn.data.connected);
    });

  return mobileDataConnected;
};

var LayoutItemList = function(app) {
  this.app = app;

  this.closeLockManager = app.closeLockManager;
  this.dictionaryList = null;
  this.downloadPreference = null;
  this._layoutConfigQueue = null;

  // This set stores the ids of enabled layouts.
  this._installedLayoutListSet = null;

  this.layoutItems = null;
};

LayoutItemList.prototype.ENABLED_LAYOUT_KEY = 'layout.dynamic-installed';

// JSON file lists included layouts, generated by build script.
LayoutItemList.prototype.CONFIG_FILE_PATH = './js/settings/layouts.json';

LayoutItemList.prototype.onready = null;

LayoutItemList.prototype.start = function() {
  this.dictionaryList = new LayoutDictionaryList(this);
  this.dictionaryList.start();

  this.downloadPreference = new DownloadPreference(this.app);
  this.downloadPreference.start();

  this.layoutItems = new Map();

  var p = this._getConfig()
    .then(this._createLayoutItemsFromLayouts.bind(this))
    .then(function() {
      if (typeof this.onready === 'function') {
        this.onready();
      }
    }.bind(this));

  this._layoutConfigQueue = p
    .catch(function(e) {
      e && console.error(e);
    });

  // Return this promise in the start() function so unit test could catch the
  // errors. Note that we do not expect the promise to reject in production
  // so it's ok if the user of the class don't handle it.
  return p;
};

LayoutItemList.prototype.stop = function() {
  this.layoutItems.forEach(function(layoutItem) {
    layoutItem.stop();
  });

  this.dictionaryList.stop();
  this.dictionaryList = null;

  this.downloadPreference.stop();
  this.downloadPreference = null;

  this._layoutConfigQueue = null;
  this._installedLayoutListSet = null;
};

LayoutItemList.prototype.setLayoutAsInstalled = function(layoutId) {
  var p = this._layoutConfigQueue
    .then(function() {
      this._installedLayoutListSet.add(layoutId);

      return this.app.preferencesStore.setItem(
        this.ENABLED_LAYOUT_KEY, Array.from(this._installedLayoutListSet));
    }.bind(this))
    .catch(function(e) {
      this._installedLayoutListSet.delete(layoutId);

      throw e;
    });

  this._layoutConfigQueue = p
    .catch(function(e) {
      e && console.error(e);
    });

  return p;
};

LayoutItemList.prototype.setLayoutAsUninstalled = function(layoutId) {
  var p = this._layoutConfigQueue
    .then(function() {
      this._installedLayoutListSet.delete(layoutId);

      return this.app.preferencesStore.setItem(
        this.ENABLED_LAYOUT_KEY, Array.from(this._installedLayoutListSet));
    }.bind(this))
    .catch(function(e) {
      this._installedLayoutListSet.add(layoutId);

      throw e;
    });

  this._layoutConfigQueue = p
    .catch(function(e) {
      e && console.error(e);
    });

  return p;
};

LayoutItemList.prototype._getConfig = function() {
  var xhrPromise = new Promise(function(resolve, reject) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', this.CONFIG_FILE_PATH);
    xhr.responseType = 'json';
    xhr.onload = function() {
      if (xhr.response) {
        resolve(xhr.response);
      } else {
        reject();
      }
    };
    xhr.onerror = function() {
      reject();
    };
    xhr.send();

  }.bind(this));

  var installedLayoutsPromise =
    this.app.preferencesStore.getItem(this.ENABLED_LAYOUT_KEY);

  var p = Promise.all([xhrPromise, installedLayoutsPromise])
    .then(function(values) {
      var layouts = values[0];
      var installedLayoutListSet =
        this._installedLayoutListSet = new Set(values[1] || []);

      layouts.forEach(function(layout) {
        layout.installed =
          layout.preloaded || installedLayoutListSet.has(layout.id);
      });

      return layouts;
    }.bind(this));

  return p;
};

LayoutItemList.prototype._createLayoutItemsFromLayouts = function(layouts) {
  var needDownload = layouts.some(function(layout) {
    return (layout.preloaded === false);
  });

  // If all the layouts are preloaded,
  // we don't really need to show the list and enable the feature.
  if (!needDownload) {
    return;
  }

  this.dictionaryList.createDictionariesFromLayouts(layouts);

  layouts.forEach(function(layout) {
    var layoutItem = new LayoutItem(this, layout);
    layoutItem.start();

    this.layoutItems.set(layout.id, layoutItem);
  }, this);
};

exports.LayoutItemList = LayoutItemList;
exports.DownloadPreference = DownloadPreference;

}(window));
