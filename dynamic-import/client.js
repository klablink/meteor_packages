const Module = module.constructor;
const cache = require("./cache.js");
const {meteorInstall} = require("meteor/modules");
const dynamicVersions = require("./dynamic-versions.js");

// Fix for Safari 14 bug (https://bugs.webkit.org/show_bug.cgi?id=226547), do not delete this unused var
const idb = global.indexedDB;

const dynamicImportSettings = Meteor.settings
    && Meteor.settings.public
    && Meteor.settings.public.packages
    && Meteor.settings.public.packages['dynamic-import'] || {};

const useSourceURL = process.env.USESOURCEURL == '0';

// Call module.dynamicImport(id) to fetch a module and any/all of its
// dependencies that have not already been fetched, and evaluate them as
// soon as they arrive. This runtime API makes it very easy to implement
// ECMAScript dynamic import(...) syntax.
Module.prototype.dynamicImport = function (id) {
  const module = this;
  return module.prefetch(id).then(function () {
    return getNamespace(module, id);
  });
};

// Called by Module.prototype.prefetch if there are any missing dynamic
// modules that need to be fetched.
meteorInstall.fetch = function (ids) {
  const tree = Object.create(null);
  const versions = Object.create(null);
  let missing;

  function addSource(id, source) {
    addToTree(tree, id, makeModuleFunction(id, source, ids[id].options));
  }

  function addMissing(id) {
    addToTree(missing = missing || Object.create(null), id, 1);
  }

  Object.keys(ids).forEach(function (id) {
    const version = dynamicVersions.get(id);
    if (version) {
      versions[id] = version;
    } else {
      addMissing(id);
    }
  });

  return cache.checkMany(versions).then(function (sources) {
    Object.keys(sources).forEach(function (id) {
      const source = sources[id];
      if (source) {
        addSource(id, source);
      } else {
        addMissing(id);
      }
    });

    return missing && fetchMissing(missing).then(function (results) {
      const versionsAndSourcesById = Object.create(null);
      const flatResults = flattenModuleTree(results);

      Object.keys(flatResults).forEach(function (id) {
        const source = flatResults[id];
        addSource(id, source);

        const version = dynamicVersions.get(id);
        if (version) {
          versionsAndSourcesById[id] = {
            version,
            source,
          };
        }
      });

      cache.setMany(versionsAndSourcesById);
    });

  }).then(function () {
    return tree;
  });
};

function flattenModuleTree(tree) {
  const parts = [""];
  const result = Object.create(null);

  function walk(t) {
    if (t && typeof t === "object") {
      Object.keys(t).forEach(function (key) {
        parts.push(key);
        walk(t[key]);
        parts.pop();
      });
    } else if (typeof t === "string") {
      result[parts.join("/")] = t;
    }
  }

  walk(tree);

  return result;
}

function makeModuleFunction(id, source, options) {
  // By calling (options && options.eval || eval) in a wrapper function,
  // we delay the cost of parsing and evaluating the module code until the
  // module is first imported.
  return function () {
      const cSource = Meteor.isProduction && !useSourceURL ? `(${  source  })` : `(${  source  })\n//# sourceURL=${id}`;

    // If an options.eval function was provided in the second argument to
    // meteorInstall when this bundle was first installed, use that
    // function to parse and evaluate the dynamic module code in the scope
    // of the package. Otherwise fall back to indirect (global) eval.
    return (options && options.eval || eval)(
      // Wrap the function(require,exports,module){...} expression in
      // parentheses to force it to be parsed as an expression.
      // "(" + source + ")\n//# sourceURL=" + id
        cSource
    ).apply(this, arguments);
  };
}

let secretKey = null;
exports.setSecretKey = function (key) {
  secretKey = key;
};

const {fetchURL} = require("./common.js");

function inIframe() {
  try {
    return window.self !== window.top;
  } catch (e) {
    return true;
  }
}

function fetchMissing(missingTree) {
  // If the hostname of the URL returned by Meteor.absoluteUrl differs
  // from location.host, then we'll be making a cross-origin request here,
  // but that's fine because the dynamic-import server sets appropriate
  // CORS headers to enable fetching dynamic modules from any
  // origin. Browsers that check CORS do so by sending an additional
  // preflight OPTIONS request, which may add latency to the first dynamic
  // import() request, so it's a good idea for ROOT_URL to match
  // location.host if possible, though not strictly necessary.

  let url = fetchURL;

  const {useLocationOrigin} = dynamicImportSettings;

  const {disableLocationOriginIframe} = dynamicImportSettings;

  if (useLocationOrigin && location && !(disableLocationOriginIframe && inIframe())) {
    url = location.origin.concat(__meteor_runtime_config__.ROOT_URL_PATH_PREFIX || '', url);
  } else {
    url = Meteor.absoluteUrl(url);
  }

  if (secretKey) {
    url += `key=${  secretKey}`;
  }

  return fetch(url, {
    method: "POST",
    body: JSON.stringify(missingTree),
  }).then(function (res) {
    if (! res.ok) {
throw res;
}
    return res.json();
  });
}

function addToTree(tree, id, value) {
  const parts = id.split("/");
  const lastIndex = parts.length - 1;
  parts.forEach(function (part, i) {
    if (part) {
      tree = tree[part] = tree[part] ||
        (i < lastIndex ? Object.create(null) : value);
    }
  });
}

function getNamespace(module, id) {
  let namespace;

  module.link(id, {
    "*" (ns) {
      namespace = ns;
    },
  });

  // This helps with Babel interop, since we're not just returning the
  // module.exports object.
  Object.defineProperty(namespace, "__esModule", {
    value: true,
    enumerable: false,
  });

  return namespace;
}
