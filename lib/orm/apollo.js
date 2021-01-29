'use strict';

var Promise = require('bluebird');
var util = require('util');
var _ = require('lodash');

var elasticsearch = void 0;
try {
  // eslint-disable-next-line import/no-extraneous-dependencies, import/no-unresolved
  elasticsearch = require('elasticsearch');
} catch (e) {
  elasticsearch = null;
}

var gremlin = void 0;
try {
  // eslint-disable-next-line import/no-extraneous-dependencies, import/no-unresolved
  gremlin = require('gremlin');
} catch (e) {
  gremlin = null;
}

var dseDriver = void 0;
try {
  // eslint-disable-next-line import/no-extraneous-dependencies, import/no-unresolved
  dseDriver = require('dse-driver');
} catch (e) {
  dseDriver = null;
}

var cql = Promise.promisifyAll(dseDriver || require('cassandra-driver'));

var BaseModel = require('./base_model');
var schemer = require('../validators/schema');
var normalizer = require('../utils/normalizer');
var buildError = require('./apollo_error.js');

var KeyspaceBuilder = require('../builders/keyspace');
var UdtBuilder = require('../builders/udt');
var UdfBuilder = require('../builders/udf');
var UdaBuilder = require('../builders/uda');
var ElassandraBuilder = require('../builders/elassandra');
var JanusGraphBuilder = require('../builders/janusgraph');

var DEFAULT_REPLICATION_FACTOR = 1;

var noop = function noop() {};

var Apollo = function f(connection, options) {
  if (!connection) {
    throw buildError('model.validator.invalidconfig', 'Cassandra connection configuration undefined');
  }

  options = options || {};

  if (!options.defaultReplicationStrategy) {
    options.defaultReplicationStrategy = {
      class: 'SimpleStrategy',
      replication_factor: DEFAULT_REPLICATION_FACTOR
    };
  }

  this._options = options;
  this._models = {};
  this._keyspace = connection.keyspace;
  this._connection = connection;
  this._client = null;
  this._esclient = null;
  this._gremlin_client = null;
};

Apollo.prototype = {

  _generate_model(properties) {
    var Model = function f() {
      for (var _len = arguments.length, args = Array(_len), _key = 0; _key < _len; _key++) {
        args[_key] = arguments[_key];
      }

      BaseModel.apply(this, Array.prototype.slice.call(args));
    };

    util.inherits(Model, BaseModel);

    Object.keys(BaseModel).forEach(function (key) {
      Model[key] = BaseModel[key];
    });

    Model._set_properties(properties);

    return Model;
  },

  create_es_client() {
    if (!elasticsearch) {
      throw new Error('Configured to use elassandra, but elasticsearch module was not found, try npm install elasticsearch');
    }

    var contactPoints = this._connection.contactPoints;
    var defaultHosts = [];
    contactPoints.forEach(function (host) {
      defaultHosts.push({ host });
    });

    var esClientConfig = _.defaults(this._connection.elasticsearch, {
      hosts: defaultHosts,
      sniffOnStart: true
    });
    this._esclient = new elasticsearch.Client(esClientConfig);
    return this._esclient;
  },

  _assert_es_index(callback) {
    var esClient = this.create_es_client();
    var indexName = this._keyspace;

    var elassandraBuilder = new ElassandraBuilder(esClient);
    elassandraBuilder.assert_index(indexName, indexName, callback);
  },

  create_gremlin_client() {
    if (!gremlin) {
      throw new Error('Configured to use janus graph server, but gremlin module was not found, try npm install gremlin');
    }

    var defaultHosts = this._connection.contactPoints;

    var gremlinConfig = _.defaults(this._connection.gremlin, {
      host: defaultHosts[0],
      port: 8182,
      storage: {
        backend: 'cassandrathrift',
        hostname: defaultHosts[0],
        port: 9160
      },
      index: {
        search: {
          backend: 'elasticsearch',
          hostname: defaultHosts[0],
          port: 9200
        }
      },
      options: {}
    });
    this._gremlin_client = gremlin.createClient(gremlinConfig.port, gremlinConfig.host, gremlinConfig.options);
    this._gremlin_config = gremlinConfig;
    return this._gremlin_client;
  },

  _assert_gremlin_graph(callback) {
    var gremlinClient = this.create_gremlin_client();
    var gremlinConfig = this._gremlin_config;
    var keyspaceName = this._keyspace;
    var graphName = `${keyspaceName}_graph`;

    var graphBuilder = new JanusGraphBuilder(gremlinClient, gremlinConfig);
    graphBuilder.assert_graph(graphName, callback);
  },

  get_system_client() {
    var connection = _.cloneDeep(this._connection);
    delete connection.keyspace;

    return new cql.Client(connection);
  },

  get_keyspace_name() {
    return this._keyspace;
  },

  _assert_keyspace(callback) {
    var client = this.get_system_client();
    var keyspaceName = this._keyspace;
    var options = this._options;

    var keyspaceBuilder = new KeyspaceBuilder(client);

    keyspaceBuilder.get_keyspace(keyspaceName, function (err, keyspaceObject) {
      if (err) {
        callback(err);
        return;
      }

      if (!keyspaceObject) {
        keyspaceBuilder.create_keyspace(keyspaceName, options.defaultReplicationStrategy, callback);
        return;
      }

      var dbReplication = normalizer.normalize_replication_option(keyspaceObject.replication);
      var ormReplication = normalizer.normalize_replication_option(options.defaultReplicationStrategy);

      if (!_.isEqual(dbReplication, ormReplication)) {
        keyspaceBuilder.alter_keyspace(keyspaceName, options.defaultReplicationStrategy, callback);
        return;
      }

      client.shutdown(function () {
        callback();
      });
    });
  },

  _assert_user_defined_types(callback) {
    var client = this._define_connection;
    var options = this._options;
    var keyspace = this._keyspace;

    if (!options.udts) {
      callback();
      return;
    }

    var udtBuilder = new UdtBuilder(client);

    Promise.mapSeries(Object.keys(options.udts), function (udtKey) {
      return new Promise(function (resolve, reject) {
        var udtCallback = function udtCallback(err) {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        };
        udtBuilder.get_udt(udtKey, keyspace, function (err, udtObject) {
          if (err) {
            udtCallback(err);
            return;
          }

          if (!udtObject) {
            udtBuilder.create_udt(udtKey, options.udts[udtKey], udtCallback);
            return;
          }

          var udtKeys = Object.keys(options.udts[udtKey]);
          var udtValues = _.map(_.values(options.udts[udtKey]), normalizer.normalize_user_defined_type);
          var fieldNames = udtObject.field_names;
          var fieldTypes = _.map(udtObject.field_types, normalizer.normalize_user_defined_type);

          if (_.difference(udtKeys, fieldNames).length === 0 && _.difference(udtValues, fieldTypes).length === 0) {
            udtCallback();
            return;
          }

          throw new Error(util.format('User defined type "%s" already exists but does not match the udt definition. ' + 'Consider altering or droping the type.', udtKey));
        });
      });
    }).then(function () {
      callback();
    }).catch(function (err) {
      callback(err);
    });
  },

  _assert_user_defined_functions(callback) {
    var client = this._define_connection;
    var options = this._options;
    var keyspace = this._keyspace;

    if (!options.udfs) {
      callback();
      return;
    }

    var udfBuilder = new UdfBuilder(client);

    Promise.mapSeries(Object.keys(options.udfs), function (udfKey) {
      return new Promise(function (resolve, reject) {
        var udfCallback = function udfCallback(err) {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        };

        udfBuilder.validate_definition(udfKey, options.udfs[udfKey]);

        udfBuilder.get_udf(udfKey, keyspace, function (err, udfObject) {
          if (err) {
            udfCallback(err);
            return;
          }

          if (!udfObject) {
            udfBuilder.create_udf(udfKey, options.udfs[udfKey], udfCallback);
            return;
          }

          var udfLanguage = options.udfs[udfKey].language;
          var resultLanguage = udfObject.language;

          var udfCode = options.udfs[udfKey].code;
          var resultCode = udfObject.body;

          var udfReturnType = normalizer.normalize_user_defined_type(options.udfs[udfKey].returnType);
          var resultReturnType = normalizer.normalize_user_defined_type(udfObject.return_type);

          var udfInputs = options.udfs[udfKey].inputs ? options.udfs[udfKey].inputs : {};
          var udfInputKeys = Object.keys(udfInputs);
          var udfInputValues = _.map(_.values(udfInputs), normalizer.normalize_user_defined_type);
          var resultArgumentNames = udfObject.argument_names;
          var resultArgumentTypes = _.map(udfObject.argument_types, normalizer.normalize_user_defined_type);

          if (udfLanguage === resultLanguage && udfCode === resultCode && udfReturnType === resultReturnType && _.isEqual(udfInputKeys, resultArgumentNames) && _.isEqual(udfInputValues, resultArgumentTypes)) {
            udfCallback();
            return;
          }

          udfBuilder.create_udf(udfKey, options.udfs[udfKey], udfCallback);
        });
      });
    }).then(function () {
      callback();
    }).catch(function (err) {
      callback(err);
    });
  },

  _assert_user_defined_aggregates(callback) {
    var client = this._define_connection;
    var options = this._options;
    var keyspace = this._keyspace;

    if (!options.udas) {
      callback();
      return;
    }

    var udaBuilder = new UdaBuilder(client);

    Promise.mapSeries(Object.keys(options.udas), function (udaKey) {
      return new Promise(function (resolve, reject) {
        var udaCallback = function udaCallback(err) {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        };

        udaBuilder.validate_definition(udaKey, options.udas[udaKey]);

        if (!options.udas[udaKey].initcond) {
          options.udas[udaKey].initcond = null;
        }

        udaBuilder.get_uda(udaKey, keyspace, function (err, udaObjects) {
          if (err) {
            udaCallback(err);
            return;
          }

          if (!udaObjects) {
            udaBuilder.create_uda(udaKey, options.udas[udaKey], udaCallback);
            return;
          }

          var inputTypes = _.map(options.udas[udaKey].input_types, normalizer.normalize_user_defined_type);
          var sfunc = options.udas[udaKey].sfunc.toLowerCase();
          var stype = normalizer.normalize_user_defined_type(options.udas[udaKey].stype);
          var finalfunc = options.udas[udaKey].finalfunc ? options.udas[udaKey].finalfunc.toLowerCase() : null;
          var initcond = options.udas[udaKey].initcond ? options.udas[udaKey].initcond.replace(/[\s]/g, '') : null;

          for (var i = 0; i < udaObjects.length; i++) {
            var resultArgumentTypes = _.map(udaObjects[i].argument_types, normalizer.normalize_user_defined_type);

            var resultStateFunc = udaObjects[i].state_func;
            var resultStateType = normalizer.normalize_user_defined_type(udaObjects[i].state_type);
            var resultFinalFunc = udaObjects[i].final_func;
            var resultInitcond = udaObjects[i].initcond ? udaObjects[i].initcond.replace(/[\s]/g, '') : null;

            if (sfunc === resultStateFunc && stype === resultStateType && finalfunc === resultFinalFunc && initcond === resultInitcond && _.isEqual(inputTypes, resultArgumentTypes)) {
              udaCallback();
              return;
            }
          }
          udaBuilder.create_uda(udaKey, options.udas[udaKey], udaCallback);
        });
      });
    }).then(function () {
      callback();
    }).catch(function (err) {
      callback(err);
    });
  },

  _set_client(client) {
    var _this = this;

    var defineConnectionOptions = _.cloneDeep(this._connection);

    this._client = client;
    this._define_connection = new cql.Client(defineConnectionOptions);

    // Reset connections on all models
    Object.keys(this._models).forEach(function (i) {
      _this._models[i]._properties.cql = _this._client;
      _this._models[i]._properties.define_connection = _this._define_connection;
    });
  },

  init(callback) {
    var _this2 = this;

    var onUserDefinedAggregates = function onUserDefinedAggregates(err) {
      if (err) {
        callback(err);
        return;
      }

      var managementTasks = [];
      if (_this2._keyspace && _this2._options.manageESIndex) {
        _this2.assertESIndexAsync = Promise.promisify(_this2._assert_es_index);
        managementTasks.push(_this2.assertESIndexAsync());
      }
      if (_this2._keyspace && _this2._options.manageGraphs) {
        _this2.assertGremlinGraphAsync = Promise.promisify(_this2._assert_gremlin_graph);
        managementTasks.push(_this2.assertGremlinGraphAsync());
      }
      Promise.all(managementTasks).then(function () {
        callback(null, _this2);
      }).catch(function (err1) {
        callback(err1);
      });
    };

    var onUserDefinedFunctions = function f(err) {
      if (err) {
        callback(err);
        return;
      }
      try {
        this._assert_user_defined_aggregates(onUserDefinedAggregates.bind(this));
      } catch (e) {
        throw buildError('model.validator.invaliduda', e.message);
      }
    };

    var onUserDefinedTypes = function f(err) {
      if (err) {
        callback(err);
        return;
      }
      try {
        this._assert_user_defined_functions(onUserDefinedFunctions.bind(this));
      } catch (e) {
        throw buildError('model.validator.invalidudf', e.message);
      }
    };

    var onKeyspace = function f(err) {
      if (err) {
        callback(err);
        return;
      }
      this._set_client(new cql.Client(this._connection));
      try {
        this._assert_user_defined_types(onUserDefinedTypes.bind(this));
      } catch (e) {
        throw buildError('model.validator.invalidudt', e.message);
      }
    };

    if (this._keyspace && this._options.createKeyspace !== false) {
      this._assert_keyspace(onKeyspace.bind(this));
    } else {
      onKeyspace.call(this);
    }
  },

  addModel(modelName, modelSchema) {
    if (!modelName || typeof modelName !== 'string') {
      throw buildError('model.validator.invalidschema', 'Model name must be a valid string');
    }

    try {
      schemer.validate_model_schema(modelSchema);
    } catch (e) {
      throw buildError('model.validator.invalidschema', e.message);
    }

    if (modelSchema.options && modelSchema.options.timestamps) {
      var timestampOptions = {
        createdAt: modelSchema.options.timestamps.createdAt || 'createdAt',
        updatedAt: modelSchema.options.timestamps.updatedAt || 'updatedAt'
      };
      modelSchema.options.timestamps = timestampOptions;

      modelSchema.fields[modelSchema.options.timestamps.createdAt] = {
        type: 'timestamp',
        default: {
          $db_function: 'toTimestamp(now())'
        }
      };
      modelSchema.fields[modelSchema.options.timestamps.updatedAt] = {
        type: 'timestamp',
        default: {
          $db_function: 'toTimestamp(now())'
        }
      };
    }

    if (modelSchema.options && modelSchema.options.versions) {
      var versionOptions = {
        key: modelSchema.options.versions.key || '__v'
      };
      modelSchema.options.versions = versionOptions;

      modelSchema.fields[modelSchema.options.versions.key] = {
        type: 'timeuuid',
        default: {
          $db_function: 'now()'
        }
      };
    }

    var baseProperties = {
      name: modelName,
      schema: modelSchema,
      keyspace: this._keyspace,
      define_connection: this._define_connection,
      cql: this._client,
      esclient: this._esclient,
      gremlin_client: this._gremlin_client,
      get_constructor: this.getModel.bind(this, modelName),
      init: this.init.bind(this),
      dropTableOnSchemaChange: this._options.dropTableOnSchemaChange,
      createTable: this._options.createTable,
      migration: this._options.migration,
      disableTTYConfirmation: this._options.disableTTYConfirmation
    };

    this._models[modelName] = this._generate_model(baseProperties);
    return this._models[modelName];
  },

  getModel(modelName) {
    return this._models[modelName] || null;
  },

  close(callback) {
    callback = callback || noop;

    if (this.orm._esclient) {
      this.orm._esclient.close();
    }

    if (this.orm._gremlin_client && this.orm._gremlin_client.connection && this.orm._gremlin_client.connection.ws) {
      this.orm._gremlin_client.connection.ws.close();
    }

    var clientsToShutdown = [];
    if (this.orm._client) {
      clientsToShutdown.push(this.orm._client.shutdown());
    }
    if (this.orm._define_connection) {
      clientsToShutdown.push(this.orm._define_connection.shutdown());
    }

    Promise.all(clientsToShutdown).then(function () {
      callback();
    }).catch(function (err) {
      callback(err);
    });
  }
};

module.exports = Apollo;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9vcm0vYXBvbGxvLmpzIl0sIm5hbWVzIjpbIlByb21pc2UiLCJyZXF1aXJlIiwidXRpbCIsIl8iLCJlbGFzdGljc2VhcmNoIiwiZSIsImdyZW1saW4iLCJkc2VEcml2ZXIiLCJjcWwiLCJwcm9taXNpZnlBbGwiLCJCYXNlTW9kZWwiLCJzY2hlbWVyIiwibm9ybWFsaXplciIsImJ1aWxkRXJyb3IiLCJLZXlzcGFjZUJ1aWxkZXIiLCJVZHRCdWlsZGVyIiwiVWRmQnVpbGRlciIsIlVkYUJ1aWxkZXIiLCJFbGFzc2FuZHJhQnVpbGRlciIsIkphbnVzR3JhcGhCdWlsZGVyIiwiREVGQVVMVF9SRVBMSUNBVElPTl9GQUNUT1IiLCJub29wIiwiQXBvbGxvIiwiZiIsImNvbm5lY3Rpb24iLCJvcHRpb25zIiwiZGVmYXVsdFJlcGxpY2F0aW9uU3RyYXRlZ3kiLCJjbGFzcyIsInJlcGxpY2F0aW9uX2ZhY3RvciIsIl9vcHRpb25zIiwiX21vZGVscyIsIl9rZXlzcGFjZSIsImtleXNwYWNlIiwiX2Nvbm5lY3Rpb24iLCJfY2xpZW50IiwiX2VzY2xpZW50IiwiX2dyZW1saW5fY2xpZW50IiwicHJvdG90eXBlIiwiX2dlbmVyYXRlX21vZGVsIiwicHJvcGVydGllcyIsIk1vZGVsIiwiYXJncyIsImFwcGx5IiwiQXJyYXkiLCJzbGljZSIsImNhbGwiLCJpbmhlcml0cyIsIk9iamVjdCIsImtleXMiLCJmb3JFYWNoIiwia2V5IiwiX3NldF9wcm9wZXJ0aWVzIiwiY3JlYXRlX2VzX2NsaWVudCIsIkVycm9yIiwiY29udGFjdFBvaW50cyIsImRlZmF1bHRIb3N0cyIsImhvc3QiLCJwdXNoIiwiZXNDbGllbnRDb25maWciLCJkZWZhdWx0cyIsImhvc3RzIiwic25pZmZPblN0YXJ0IiwiQ2xpZW50IiwiX2Fzc2VydF9lc19pbmRleCIsImNhbGxiYWNrIiwiZXNDbGllbnQiLCJpbmRleE5hbWUiLCJlbGFzc2FuZHJhQnVpbGRlciIsImFzc2VydF9pbmRleCIsImNyZWF0ZV9ncmVtbGluX2NsaWVudCIsImdyZW1saW5Db25maWciLCJwb3J0Iiwic3RvcmFnZSIsImJhY2tlbmQiLCJob3N0bmFtZSIsImluZGV4Iiwic2VhcmNoIiwiY3JlYXRlQ2xpZW50IiwiX2dyZW1saW5fY29uZmlnIiwiX2Fzc2VydF9ncmVtbGluX2dyYXBoIiwiZ3JlbWxpbkNsaWVudCIsImtleXNwYWNlTmFtZSIsImdyYXBoTmFtZSIsImdyYXBoQnVpbGRlciIsImFzc2VydF9ncmFwaCIsImdldF9zeXN0ZW1fY2xpZW50IiwiY2xvbmVEZWVwIiwiZ2V0X2tleXNwYWNlX25hbWUiLCJfYXNzZXJ0X2tleXNwYWNlIiwiY2xpZW50Iiwia2V5c3BhY2VCdWlsZGVyIiwiZ2V0X2tleXNwYWNlIiwiZXJyIiwia2V5c3BhY2VPYmplY3QiLCJjcmVhdGVfa2V5c3BhY2UiLCJkYlJlcGxpY2F0aW9uIiwibm9ybWFsaXplX3JlcGxpY2F0aW9uX29wdGlvbiIsInJlcGxpY2F0aW9uIiwib3JtUmVwbGljYXRpb24iLCJpc0VxdWFsIiwiYWx0ZXJfa2V5c3BhY2UiLCJzaHV0ZG93biIsIl9hc3NlcnRfdXNlcl9kZWZpbmVkX3R5cGVzIiwiX2RlZmluZV9jb25uZWN0aW9uIiwidWR0cyIsInVkdEJ1aWxkZXIiLCJtYXBTZXJpZXMiLCJ1ZHRLZXkiLCJyZXNvbHZlIiwicmVqZWN0IiwidWR0Q2FsbGJhY2siLCJnZXRfdWR0IiwidWR0T2JqZWN0IiwiY3JlYXRlX3VkdCIsInVkdEtleXMiLCJ1ZHRWYWx1ZXMiLCJtYXAiLCJ2YWx1ZXMiLCJub3JtYWxpemVfdXNlcl9kZWZpbmVkX3R5cGUiLCJmaWVsZE5hbWVzIiwiZmllbGRfbmFtZXMiLCJmaWVsZFR5cGVzIiwiZmllbGRfdHlwZXMiLCJkaWZmZXJlbmNlIiwibGVuZ3RoIiwiZm9ybWF0IiwidGhlbiIsImNhdGNoIiwiX2Fzc2VydF91c2VyX2RlZmluZWRfZnVuY3Rpb25zIiwidWRmcyIsInVkZkJ1aWxkZXIiLCJ1ZGZLZXkiLCJ1ZGZDYWxsYmFjayIsInZhbGlkYXRlX2RlZmluaXRpb24iLCJnZXRfdWRmIiwidWRmT2JqZWN0IiwiY3JlYXRlX3VkZiIsInVkZkxhbmd1YWdlIiwibGFuZ3VhZ2UiLCJyZXN1bHRMYW5ndWFnZSIsInVkZkNvZGUiLCJjb2RlIiwicmVzdWx0Q29kZSIsImJvZHkiLCJ1ZGZSZXR1cm5UeXBlIiwicmV0dXJuVHlwZSIsInJlc3VsdFJldHVyblR5cGUiLCJyZXR1cm5fdHlwZSIsInVkZklucHV0cyIsImlucHV0cyIsInVkZklucHV0S2V5cyIsInVkZklucHV0VmFsdWVzIiwicmVzdWx0QXJndW1lbnROYW1lcyIsImFyZ3VtZW50X25hbWVzIiwicmVzdWx0QXJndW1lbnRUeXBlcyIsImFyZ3VtZW50X3R5cGVzIiwiX2Fzc2VydF91c2VyX2RlZmluZWRfYWdncmVnYXRlcyIsInVkYXMiLCJ1ZGFCdWlsZGVyIiwidWRhS2V5IiwidWRhQ2FsbGJhY2siLCJpbml0Y29uZCIsImdldF91ZGEiLCJ1ZGFPYmplY3RzIiwiY3JlYXRlX3VkYSIsImlucHV0VHlwZXMiLCJpbnB1dF90eXBlcyIsInNmdW5jIiwidG9Mb3dlckNhc2UiLCJzdHlwZSIsImZpbmFsZnVuYyIsInJlcGxhY2UiLCJpIiwicmVzdWx0U3RhdGVGdW5jIiwic3RhdGVfZnVuYyIsInJlc3VsdFN0YXRlVHlwZSIsInN0YXRlX3R5cGUiLCJyZXN1bHRGaW5hbEZ1bmMiLCJmaW5hbF9mdW5jIiwicmVzdWx0SW5pdGNvbmQiLCJfc2V0X2NsaWVudCIsImRlZmluZUNvbm5lY3Rpb25PcHRpb25zIiwiX3Byb3BlcnRpZXMiLCJkZWZpbmVfY29ubmVjdGlvbiIsImluaXQiLCJvblVzZXJEZWZpbmVkQWdncmVnYXRlcyIsIm1hbmFnZW1lbnRUYXNrcyIsIm1hbmFnZUVTSW5kZXgiLCJhc3NlcnRFU0luZGV4QXN5bmMiLCJwcm9taXNpZnkiLCJtYW5hZ2VHcmFwaHMiLCJhc3NlcnRHcmVtbGluR3JhcGhBc3luYyIsImFsbCIsImVycjEiLCJvblVzZXJEZWZpbmVkRnVuY3Rpb25zIiwiYmluZCIsIm1lc3NhZ2UiLCJvblVzZXJEZWZpbmVkVHlwZXMiLCJvbktleXNwYWNlIiwiY3JlYXRlS2V5c3BhY2UiLCJhZGRNb2RlbCIsIm1vZGVsTmFtZSIsIm1vZGVsU2NoZW1hIiwidmFsaWRhdGVfbW9kZWxfc2NoZW1hIiwidGltZXN0YW1wcyIsInRpbWVzdGFtcE9wdGlvbnMiLCJjcmVhdGVkQXQiLCJ1cGRhdGVkQXQiLCJmaWVsZHMiLCJ0eXBlIiwiZGVmYXVsdCIsIiRkYl9mdW5jdGlvbiIsInZlcnNpb25zIiwidmVyc2lvbk9wdGlvbnMiLCJiYXNlUHJvcGVydGllcyIsIm5hbWUiLCJzY2hlbWEiLCJlc2NsaWVudCIsImdyZW1saW5fY2xpZW50IiwiZ2V0X2NvbnN0cnVjdG9yIiwiZ2V0TW9kZWwiLCJkcm9wVGFibGVPblNjaGVtYUNoYW5nZSIsImNyZWF0ZVRhYmxlIiwibWlncmF0aW9uIiwiZGlzYWJsZVRUWUNvbmZpcm1hdGlvbiIsImNsb3NlIiwib3JtIiwid3MiLCJjbGllbnRzVG9TaHV0ZG93biIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiI7O0FBQUEsSUFBTUEsVUFBVUMsUUFBUSxVQUFSLENBQWhCO0FBQ0EsSUFBTUMsT0FBT0QsUUFBUSxNQUFSLENBQWI7QUFDQSxJQUFNRSxJQUFJRixRQUFRLFFBQVIsQ0FBVjs7QUFFQSxJQUFJRyxzQkFBSjtBQUNBLElBQUk7QUFDRjtBQUNBQSxrQkFBZ0JILFFBQVEsZUFBUixDQUFoQjtBQUNELENBSEQsQ0FHRSxPQUFPSSxDQUFQLEVBQVU7QUFDVkQsa0JBQWdCLElBQWhCO0FBQ0Q7O0FBRUQsSUFBSUUsZ0JBQUo7QUFDQSxJQUFJO0FBQ0Y7QUFDQUEsWUFBVUwsUUFBUSxTQUFSLENBQVY7QUFDRCxDQUhELENBR0UsT0FBT0ksQ0FBUCxFQUFVO0FBQ1ZDLFlBQVUsSUFBVjtBQUNEOztBQUVELElBQUlDLGtCQUFKO0FBQ0EsSUFBSTtBQUNGO0FBQ0FBLGNBQVlOLFFBQVEsWUFBUixDQUFaO0FBQ0QsQ0FIRCxDQUdFLE9BQU9JLENBQVAs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TixNQUFqQiIsImZpbGUiOiJhcG9sbG8uanMiLCJzb3VyY2VzQ29udGVudCI6WyJjb25zdCBQcm9taXNlID0gcmVxdWlyZSgnYmx1ZWJpcmQnKTtcbmNvbnN0IHV0aWwgPSByZXF1aXJlKCd1dGlsJyk7XG5jb25zdCBfID0gcmVxdWlyZSgnbG9kYXNoJyk7XG5cbmxldCBlbGFzdGljc2VhcmNoO1xudHJ5IHtcbiAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIGltcG9ydC9uby1leHRyYW5lb3VzLWRlcGVuZGVuY2llcywgaW1wb3J0L25vLXVucmVzb2x2ZWRcbiAgZWxhc3RpY3NlYXJjaCA9IHJlcXVpcmUoJ2VsYXN0aWNzZWFyY2gnKTtcbn0gY2F0Y2ggKGUpIHtcbiAgZWxhc3RpY3NlYXJjaCA9IG51bGw7XG59XG5cbmxldCBncmVtbGluO1xudHJ5IHtcbiAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIGltcG9ydC9uby1leHRyYW5lb3VzLWRlcGVuZGVuY2llcywgaW1wb3J0L25vLXVucmVzb2x2ZWRcbiAgZ3JlbWxpbiA9IHJlcXVpcmUoJ2dyZW1saW4nKTtcbn0gY2F0Y2ggKGUpIHtcbiAgZ3JlbWxpbiA9IG51bGw7XG59XG5cbmxldCBkc2VEcml2ZXI7XG50cnkge1xuICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgaW1wb3J0L25vLWV4dHJhbmVvdXMtZGVwZW5kZW5jaWVzLCBpbXBvcnQvbm8tdW5yZXNvbHZlZFxuICBkc2VEcml2ZXIgPSByZXF1aXJlKCdkc2UtZHJpdmVyJyk7XG59IGNhdGNoIChlKSB7XG4gIGRzZURyaXZlciA9IG51bGw7XG59XG5cbmNvbnN0IGNxbCA9IFByb21pc2UucHJvbWlzaWZ5QWxsKGRzZURyaXZlciB8fCByZXF1aXJlKCdjYXNzYW5kcmEtZHJpdmVyJykpO1xuXG5jb25zdCBCYXNlTW9kZWwgPSByZXF1aXJlKCcuL2Jhc2VfbW9kZWwnKTtcbmNvbnN0IHNjaGVtZXIgPSByZXF1aXJlKCcuLi92YWxpZGF0b3JzL3NjaGVtYScpO1xuY29uc3Qgbm9ybWFsaXplciA9IHJlcXVpcmUoJy4uL3V0aWxzL25vcm1hbGl6ZXInKTtcbmNvbnN0IGJ1aWxkRXJyb3IgPSByZXF1aXJlKCcuL2Fwb2xsb19lcnJvci5qcycpO1xuXG5jb25zdCBLZXlzcGFjZUJ1aWxkZXIgPSByZXF1aXJlKCcuLi9idWlsZGVycy9rZXlzcGFjZScpO1xuY29uc3QgVWR0QnVpbGRlciA9IHJlcXVpcmUoJy4uL2J1aWxkZXJzL3VkdCcpO1xuY29uc3QgVWRmQnVpbGRlciA9IHJlcXVpcmUoJy4uL2J1aWxkZXJzL3VkZicpO1xuY29uc3QgVWRhQnVpbGRlciA9IHJlcXVpcmUoJy4uL2J1aWxkZXJzL3VkYScpO1xuY29uc3QgRWxhc3NhbmRyYUJ1aWxkZXIgPSByZXF1aXJlKCcuLi9idWlsZGVycy9lbGFzc2FuZHJhJyk7XG5jb25zdCBKYW51c0dyYXBoQnVpbGRlciA9IHJlcXVpcmUoJy4uL2J1aWxkZXJzL2phbnVzZ3JhcGgnKTtcblxuY29uc3QgREVGQVVMVF9SRVBMSUNBVElPTl9GQUNUT1IgPSAxO1xuXG5jb25zdCBub29wID0gKCkgPT4ge307XG5cbmNvbnN0IEFwb2xsbyA9IGZ1bmN0aW9uIGYoY29ubmVjdGlvbiwgb3B0aW9ucykge1xuICBpZiAoIWNvbm5lY3Rpb24pIHtcbiAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwudmFsaWRhdG9yLmludmFsaWRjb25maWcnLCAnQ2Fzc2FuZHJhIGNvbm5lY3Rpb24gY29uZmlndXJhdGlvbiB1bmRlZmluZWQnKSk7XG4gIH1cblxuICBvcHRpb25zID0gb3B0aW9ucyB8fCB7fTtcblxuICBpZiAoIW9wdGlvbnMuZGVmYXVsdFJlcGxpY2F0aW9uU3RyYXRlZ3kpIHtcbiAgICBvcHRpb25zLmRlZmF1bHRSZXBsaWNhdGlvblN0cmF0ZWd5ID0ge1xuICAgICAgY2xhc3M6ICdTaW1wbGVTdHJhdGVneScsXG4gICAgICByZXBsaWNhdGlvbl9mYWN0b3I6IERFRkFVTFRfUkVQTElDQVRJT05fRkFDVE9SLFxuICAgIH07XG4gIH1cblxuICB0aGlzLl9vcHRpb25zID0gb3B0aW9ucztcbiAgdGhpcy5fbW9kZWxzID0ge307XG4gIHRoaXMuX2tleXNwYWNlID0gY29ubmVjdGlvbi5rZXlzcGFjZTtcbiAgdGhpcy5fY29ubmVjdGlvbiA9IGNvbm5lY3Rpb247XG4gIHRoaXMuX2NsaWVudCA9IG51bGw7XG4gIHRoaXMuX2VzY2xpZW50ID0gbnVsbDtcbiAgdGhpcy5fZ3JlbWxpbl9jbGllbnQgPSBudWxsO1xufTtcblxuQXBvbGxvLnByb3RvdHlwZSA9IHtcblxuICBfZ2VuZXJhdGVfbW9kZWwocHJvcGVydGllcykge1xuICAgIGNvbnN0IE1vZGVsID0gZnVuY3Rpb24gZiguLi5hcmdzKSB7XG4gICAgICBCYXNlTW9kZWwuYXBwbHkodGhpcywgQXJyYXkucHJvdG90eXBlLnNsaWNlLmNhbGwoYXJncykpO1xuICAgIH07XG5cbiAgICB1dGlsLmluaGVyaXRzKE1vZGVsLCBCYXNlTW9kZWwpO1xuXG4gICAgT2JqZWN0LmtleXMoQmFzZU1vZGVsKS5mb3JFYWNoKChrZXkpID0+IHtcbiAgICAgIE1vZGVsW2tleV0gPSBCYXNlTW9kZWxba2V5XTtcbiAgICB9KTtcblxuICAgIE1vZGVsLl9zZXRfcHJvcGVydGllcyhwcm9wZXJ0aWVzKTtcblxuICAgIHJldHVybiBNb2RlbDtcbiAgfSxcblxuICBjcmVhdGVfZXNfY2xpZW50KCkge1xuICAgIGlmICghZWxhc3RpY3NlYXJjaCkge1xuICAgICAgdGhyb3cgKG5ldyBFcnJvcignQ29uZmlndXJlZCB0byB1c2UgZWxhc3NhbmRyYSwgYnV0IGVsYXN0aWNzZWFyY2ggbW9kdWxlIHdhcyBub3QgZm91bmQsIHRyeSBucG0gaW5zdGFsbCBlbGFzdGljc2VhcmNoJykpO1xuICAgIH1cblxuICAgIGNvbnN0IGNvbnRhY3RQb2ludHMgPSB0aGlzLl9jb25uZWN0aW9uLmNvbnRhY3RQb2ludHM7XG4gICAgY29uc3QgZGVmYXVsdEhvc3RzID0gW107XG4gICAgY29udGFjdFBvaW50cy5mb3JFYWNoKChob3N0KSA9PiB7XG4gICAgICBkZWZhdWx0SG9zdHMucHVzaCh7IGhvc3QgfSk7XG4gICAgfSk7XG5cbiAgICBjb25zdCBlc0NsaWVudENvbmZpZyA9IF8uZGVmYXVsdHModGhpcy5fY29ubmVjdGlvbi5lbGFzdGljc2VhcmNoLCB7XG4gICAgICBob3N0czogZGVmYXVsdEhvc3RzLFxuICAgICAgc25pZmZPblN0YXJ0OiB0cnVlLFxuICAgIH0pO1xuICAgIHRoaXMuX2VzY2xpZW50ID0gbmV3IGVsYXN0aWNzZWFyY2guQ2xpZW50KGVzQ2xpZW50Q29uZmlnKTtcbiAgICByZXR1cm4gdGhpcy5fZXNjbGllbnQ7XG4gIH0sXG5cbiAgX2Fzc2VydF9lc19pbmRleChjYWxsYmFjaykge1xuICAgIGNvbnN0IGVzQ2xpZW50ID0gdGhpcy5jcmVhdGVfZXNfY2xpZW50KCk7XG4gICAgY29uc3QgaW5kZXhOYW1lID0gdGhpcy5fa2V5c3BhY2U7XG5cbiAgICBjb25zdCBlbGFzc2FuZHJhQnVpbGRlciA9IG5ldyBFbGFzc2FuZHJhQnVpbGRlcihlc0NsaWVudCk7XG4gICAgZWxhc3NhbmRyYUJ1aWxkZXIuYXNzZXJ0X2luZGV4KGluZGV4TmFtZSwgaW5kZXhOYW1lLCBjYWxsYmFjayk7XG4gIH0sXG5cbiAgY3JlYXRlX2dyZW1saW5fY2xpZW50KCkge1xuICAgIGlmICghZ3JlbWxpbikge1xuICAgICAgdGhyb3cgKG5ldyBFcnJvcignQ29uZmlndXJlZCB0byB1c2UgamFudXMgZ3JhcGggc2VydmVyLCBidXQgZ3JlbWxpbiBtb2R1bGUgd2FzIG5vdCBmb3VuZCwgdHJ5IG5wbSBpbnN0YWxsIGdyZW1saW4nKSk7XG4gICAgfVxuXG4gICAgY29uc3QgZGVmYXVsdEhvc3RzID0gdGhpcy5fY29ubmVjdGlvbi5jb250YWN0UG9pbnRzO1xuXG4gICAgY29uc3QgZ3JlbWxpbkNvbmZpZyA9IF8uZGVmYXVsdHModGhpcy5fY29ubmVjdGlvbi5ncmVtbGluLCB7XG4gICAgICBob3N0OiBkZWZhdWx0SG9zdHNbMF0sXG4gICAgICBwb3J0OiA4MTgyLFxuICAgICAgc3RvcmFnZToge1xuICAgICAgICBiYWNrZW5kOiAnY2Fzc2FuZHJhdGhyaWZ0JyxcbiAgICAgICAgaG9zdG5hbWU6IGRlZmF1bHRIb3N0c1swXSxcbiAgICAgICAgcG9ydDogOTE2MCxcbiAgICAgIH0sXG4gICAgICBpbmRleDoge1xuICAgICAgICBzZWFyY2g6IHtcbiAgICAgICAgICBiYWNrZW5kOiAnZWxhc3RpY3NlYXJjaCcsXG4gICAgICAgICAgaG9zdG5hbWU6IGRlZmF1bHRIb3N0c1swXSxcbiAgICAgICAgICBwb3J0OiA5MjAwLFxuICAgICAgICB9LFxuICAgICAgfSxcbiAgICAgIG9wdGlvbnM6IHt9LFxuICAgIH0pO1xuICAgIHRoaXMuX2dyZW1saW5fY2xpZW50ID0gZ3JlbWxpbi5jcmVhdGVDbGllbnQoZ3JlbWxpbkNvbmZpZy5wb3J0LCBncmVtbGluQ29uZmlnLmhvc3QsIGdyZW1saW5Db25maWcub3B0aW9ucyk7XG4gICAgdGhpcy5fZ3JlbWxpbl9jb25maWcgPSBncmVtbGluQ29uZmlnO1xuICAgIHJldHVybiB0aGlzLl9ncmVtbGluX2NsaWVudDtcbiAgfSxcblxuICBfYXNzZXJ0X2dyZW1saW5fZ3JhcGgoY2FsbGJhY2spIHtcbiAgICBjb25zdCBncmVtbGluQ2xpZW50ID0gdGhpcy5jcmVhdGVfZ3JlbWxpbl9jbGllbnQoKTtcbiAgICBjb25zdCBncmVtbGluQ29uZmlnID0gdGhpcy5fZ3JlbWxpbl9jb25maWc7XG4gICAgY29uc3Qga2V5c3BhY2VOYW1lID0gdGhpcy5fa2V5c3BhY2U7XG4gICAgY29uc3QgZ3JhcGhOYW1lID0gYCR7a2V5c3BhY2VOYW1lfV9ncmFwaGA7XG5cbiAgICBjb25zdCBncmFwaEJ1aWxkZXIgPSBuZXcgSmFudXNHcmFwaEJ1aWxkZXIoZ3JlbWxpbkNsaWVudCwgZ3JlbWxpbkNvbmZpZyk7XG4gICAgZ3JhcGhCdWlsZGVyLmFzc2VydF9ncmFwaChncmFwaE5hbWUsIGNhbGxiYWNrKTtcbiAgfSxcblxuICBnZXRfc3lzdGVtX2NsaWVudCgpIHtcbiAgICBjb25zdCBjb25uZWN0aW9uID0gXy5jbG9uZURlZXAodGhpcy5fY29ubmVjdGlvbik7XG4gICAgZGVsZXRlIGNvbm5lY3Rpb24ua2V5c3BhY2U7XG5cbiAgICByZXR1cm4gbmV3IGNxbC5DbGllbnQoY29ubmVjdGlvbik7XG4gIH0sXG5cbiAgZ2V0X2tleXNwYWNlX25hbWUoKSB7XG4gICAgcmV0dXJuIHRoaXMuX2tleXNwYWNlO1xuICB9LFxuXG4gIF9hc3NlcnRfa2V5c3BhY2UoY2FsbGJhY2spIHtcbiAgICBjb25zdCBjbGllbnQgPSB0aGlzLmdldF9zeXN0ZW1fY2xpZW50KCk7XG4gICAgY29uc3Qga2V5c3BhY2VOYW1lID0gdGhpcy5fa2V5c3BhY2U7XG4gICAgY29uc3Qgb3B0aW9ucyA9IHRoaXMuX29wdGlvbnM7XG5cbiAgICBjb25zdCBrZXlzcGFjZUJ1aWxkZXIgPSBuZXcgS2V5c3BhY2VCdWlsZGVyKGNsaWVudCk7XG5cbiAgICBrZXlzcGFjZUJ1aWxkZXIuZ2V0X2tleXNwYWNlKGtleXNwYWNlTmFtZSwgKGVyciwga2V5c3BhY2VPYmplY3QpID0+IHtcbiAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgY2FsbGJhY2soZXJyKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBpZiAoIWtleXNwYWNlT2JqZWN0KSB7XG4gICAgICAgIGtleXNwYWNlQnVpbGRlci5jcmVhdGVfa2V5c3BhY2Uoa2V5c3BhY2VOYW1lLCBvcHRpb25zLmRlZmF1bHRSZXBsaWNhdGlvblN0cmF0ZWd5LCBjYWxsYmFjayk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgY29uc3QgZGJSZXBsaWNhdGlvbiA9IG5vcm1hbGl6ZXIubm9ybWFsaXplX3JlcGxpY2F0aW9uX29wdGlvbihrZXlzcGFjZU9iamVjdC5yZXBsaWNhdGlvbik7XG4gICAgICBjb25zdCBvcm1SZXBsaWNhdGlvbiA9IG5vcm1hbGl6ZXIubm9ybWFsaXplX3JlcGxpY2F0aW9uX29wdGlvbihvcHRpb25zLmRlZmF1bHRSZXBsaWNhdGlvblN0cmF0ZWd5KTtcblxuICAgICAgaWYgKCFfLmlzRXF1YWwoZGJSZXBsaWNhdGlvbiwgb3JtUmVwbGljYXRpb24pKSB7XG4gICAgICAgIGtleXNwYWNlQnVpbGRlci5hbHRlcl9rZXlzcGFjZShrZXlzcGFjZU5hbWUsIG9wdGlvbnMuZGVmYXVsdFJlcGxpY2F0aW9uU3RyYXRlZ3ksIGNhbGxiYWNrKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBjbGllbnQuc2h1dGRvd24oKCkgPT4ge1xuICAgICAgICBjYWxsYmFjaygpO1xuICAgICAgfSk7XG4gICAgfSk7XG4gIH0sXG5cbiAgX2Fzc2VydF91c2VyX2RlZmluZWRfdHlwZXMoY2FsbGJhY2spIHtcbiAgICBjb25zdCBjbGllbnQgPSB0aGlzLl9kZWZpbmVfY29ubmVjdGlvbjtcbiAgICBjb25zdCBvcHRpb25zID0gdGhpcy5fb3B0aW9ucztcbiAgICBjb25zdCBrZXlzcGFjZSA9IHRoaXMuX2tleXNwYWNlO1xuXG4gICAgaWYgKCFvcHRpb25zLnVkdHMpIHtcbiAgICAgIGNhbGxiYWNrKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3QgdWR0QnVpbGRlciA9IG5ldyBVZHRCdWlsZGVyKGNsaWVudCk7XG5cbiAgICBQcm9taXNlLm1hcFNlcmllcyhPYmplY3Qua2V5cyhvcHRpb25zLnVkdHMpLCAodWR0S2V5KSA9PiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICBjb25zdCB1ZHRDYWxsYmFjayA9IChlcnIpID0+IHtcbiAgICAgICAgaWYgKGVycikge1xuICAgICAgICAgIHJlamVjdChlcnIpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICByZXNvbHZlKCk7XG4gICAgICB9O1xuICAgICAgdWR0QnVpbGRlci5nZXRfdWR0KHVkdEtleSwga2V5c3BhY2UsIChlcnIsIHVkdE9iamVjdCkgPT4ge1xuICAgICAgICBpZiAoZXJyKSB7XG4gICAgICAgICAgdWR0Q2FsbGJhY2soZXJyKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIXVkdE9iamVjdCkge1xuICAgICAgICAgIHVkdEJ1aWxkZXIuY3JlYXRlX3VkdCh1ZHRLZXksIG9wdGlvbnMudWR0c1t1ZHRLZXldLCB1ZHRDYWxsYmFjayk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgdWR0S2V5cyA9IE9iamVjdC5rZXlzKG9wdGlvbnMudWR0c1t1ZHRLZXldKTtcbiAgICAgICAgY29uc3QgdWR0VmFsdWVzID0gXy5tYXAoXy52YWx1ZXMob3B0aW9ucy51ZHRzW3VkdEtleV0pLCBub3JtYWxpemVyLm5vcm1hbGl6ZV91c2VyX2RlZmluZWRfdHlwZSk7XG4gICAgICAgIGNvbnN0IGZpZWxkTmFtZXMgPSB1ZHRPYmplY3QuZmllbGRfbmFtZXM7XG4gICAgICAgIGNvbnN0IGZpZWxkVHlwZXMgPSBfLm1hcCh1ZHRPYmplY3QuZmllbGRfdHlwZXMsIG5vcm1hbGl6ZXIubm9ybWFsaXplX3VzZXJfZGVmaW5lZF90eXBlKTtcblxuICAgICAgICBpZiAoXy5kaWZmZXJlbmNlKHVkdEtleXMsIGZpZWxkTmFtZXMpLmxlbmd0aCA9PT0gMCAmJiBfLmRpZmZlcmVuY2UodWR0VmFsdWVzLCBmaWVsZFR5cGVzKS5sZW5ndGggPT09IDApIHtcbiAgICAgICAgICB1ZHRDYWxsYmFjaygpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIHRocm93IChuZXcgRXJyb3IodXRpbC5mb3JtYXQoXG4gICAgICAgICAgJ1VzZXIgZGVmaW5lZCB0eXBlIFwiJXNcIiBhbHJlYWR5IGV4aXN0cyBidXQgZG9lcyBub3QgbWF0Y2ggdGhlIHVkdCBkZWZpbml0aW9uLiAnICtcbiAgICAgICAgICAnQ29uc2lkZXIgYWx0ZXJpbmcgb3IgZHJvcGluZyB0aGUgdHlwZS4nLFxuICAgICAgICAgIHVkdEtleSxcbiAgICAgICAgKSkpO1xuICAgICAgfSk7XG4gICAgfSkpXG4gICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgIGNhbGxiYWNrKCk7XG4gICAgICB9KVxuICAgICAgLmNhdGNoKChlcnIpID0+IHtcbiAgICAgICAgY2FsbGJhY2soZXJyKTtcbiAgICAgIH0pO1xuICB9LFxuXG4gIF9hc3NlcnRfdXNlcl9kZWZpbmVkX2Z1bmN0aW9ucyhjYWxsYmFjaykge1xuICAgIGNvbnN0IGNsaWVudCA9IHRoaXMuX2RlZmluZV9jb25uZWN0aW9uO1xuICAgIGNvbnN0IG9wdGlvbnMgPSB0aGlzLl9vcHRpb25zO1xuICAgIGNvbnN0IGtleXNwYWNlID0gdGhpcy5fa2V5c3BhY2U7XG5cbiAgICBpZiAoIW9wdGlvbnMudWRmcykge1xuICAgICAgY2FsbGJhY2soKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCB1ZGZCdWlsZGVyID0gbmV3IFVkZkJ1aWxkZXIoY2xpZW50KTtcblxuICAgIFByb21pc2UubWFwU2VyaWVzKE9iamVjdC5rZXlzKG9wdGlvbnMudWRmcyksICh1ZGZLZXkpID0+IG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgIGNvbnN0IHVkZkNhbGxiYWNrID0gKGVycikgPT4ge1xuICAgICAgICBpZiAoZXJyKSB7XG4gICAgICAgICAgcmVqZWN0KGVycik7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIHJlc29sdmUoKTtcbiAgICAgIH07XG5cbiAgICAgIHVkZkJ1aWxkZXIudmFsaWRhdGVfZGVmaW5pdGlvbih1ZGZLZXksIG9wdGlvbnMudWRmc1t1ZGZLZXldKTtcblxuICAgICAgdWRmQnVpbGRlci5nZXRfdWRmKHVkZktleSwga2V5c3BhY2UsIChlcnIsIHVkZk9iamVjdCkgPT4ge1xuICAgICAgICBpZiAoZXJyKSB7XG4gICAgICAgICAgdWRmQ2FsbGJhY2soZXJyKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIXVkZk9iamVjdCkge1xuICAgICAgICAgIHVkZkJ1aWxkZXIuY3JlYXRlX3VkZih1ZGZLZXksIG9wdGlvbnMudWRmc1t1ZGZLZXldLCB1ZGZDYWxsYmFjayk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgdWRmTGFuZ3VhZ2UgPSBvcHRpb25zLnVkZnNbdWRmS2V5XS5sYW5ndWFnZTtcbiAgICAgICAgY29uc3QgcmVzdWx0TGFuZ3VhZ2UgPSB1ZGZPYmplY3QubGFuZ3VhZ2U7XG5cbiAgICAgICAgY29uc3QgdWRmQ29kZSA9IG9wdGlvbnMudWRmc1t1ZGZLZXldLmNvZGU7XG4gICAgICAgIGNvbnN0IHJlc3VsdENvZGUgPSB1ZGZPYmplY3QuYm9keTtcblxuICAgICAgICBjb25zdCB1ZGZSZXR1cm5UeXBlID0gbm9ybWFsaXplci5ub3JtYWxpemVfdXNlcl9kZWZpbmVkX3R5cGUob3B0aW9ucy51ZGZzW3VkZktleV0ucmV0dXJuVHlwZSk7XG4gICAgICAgIGNvbnN0IHJlc3VsdFJldHVyblR5cGUgPSBub3JtYWxpemVyLm5vcm1hbGl6ZV91c2VyX2RlZmluZWRfdHlwZSh1ZGZPYmplY3QucmV0dXJuX3R5cGUpO1xuXG4gICAgICAgIGNvbnN0IHVkZklucHV0cyA9IG9wdGlvbnMudWRmc1t1ZGZLZXldLmlucHV0cyA/IG9wdGlvbnMudWRmc1t1ZGZLZXldLmlucHV0cyA6IHt9O1xuICAgICAgICBjb25zdCB1ZGZJbnB1dEtleXMgPSBPYmplY3Qua2V5cyh1ZGZJbnB1dHMpO1xuICAgICAgICBjb25zdCB1ZGZJbnB1dFZhbHVlcyA9IF8ubWFwKF8udmFsdWVzKHVkZklucHV0cyksIG5vcm1hbGl6ZXIubm9ybWFsaXplX3VzZXJfZGVmaW5lZF90eXBlKTtcbiAgICAgICAgY29uc3QgcmVzdWx0QXJndW1lbnROYW1lcyA9IHVkZk9iamVjdC5hcmd1bWVudF9uYW1lcztcbiAgICAgICAgY29uc3QgcmVzdWx0QXJndW1lbnRUeXBlcyA9IF8ubWFwKHVkZk9iamVjdC5hcmd1bWVudF90eXBlcywgbm9ybWFsaXplci5ub3JtYWxpemVfdXNlcl9kZWZpbmVkX3R5cGUpO1xuXG4gICAgICAgIGlmICh1ZGZMYW5ndWFnZSA9PT0gcmVzdWx0TGFuZ3VhZ2UgJiZcbiAgICAgICAgICB1ZGZDb2RlID09PSByZXN1bHRDb2RlICYmXG4gICAgICAgICAgdWRmUmV0dXJuVHlwZSA9PT0gcmVzdWx0UmV0dXJuVHlwZSAmJlxuICAgICAgICAgIF8uaXNFcXVhbCh1ZGZJbnB1dEtleXMsIHJlc3VsdEFyZ3VtZW50TmFtZXMpICYmXG4gICAgICAgICAgXy5pc0VxdWFsKHVkZklucHV0VmFsdWVzLCByZXN1bHRBcmd1bWVudFR5cGVzKSkge1xuICAgICAgICAgIHVkZkNhbGxiYWNrKCk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgdWRmQnVpbGRlci5jcmVhdGVfdWRmKHVkZktleSwgb3B0aW9ucy51ZGZzW3VkZktleV0sIHVkZkNhbGxiYWNrKTtcbiAgICAgIH0pO1xuICAgIH0pKVxuICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICBjYWxsYmFjaygpO1xuICAgICAgfSlcbiAgICAgIC5jYXRjaCgoZXJyKSA9PiB7XG4gICAgICAgIGNhbGxiYWNrKGVycik7XG4gICAgICB9KTtcbiAgfSxcblxuICBfYXNzZXJ0X3VzZXJfZGVmaW5lZF9hZ2dyZWdhdGVzKGNhbGxiYWNrKSB7XG4gICAgY29uc3QgY2xpZW50ID0gdGhpcy5fZGVmaW5lX2Nvbm5lY3Rpb247XG4gICAgY29uc3Qgb3B0aW9ucyA9IHRoaXMuX29wdGlvbnM7XG4gICAgY29uc3Qga2V5c3BhY2UgPSB0aGlzLl9rZXlzcGFjZTtcblxuICAgIGlmICghb3B0aW9ucy51ZGFzKSB7XG4gICAgICBjYWxsYmFjaygpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IHVkYUJ1aWxkZXIgPSBuZXcgVWRhQnVpbGRlcihjbGllbnQpO1xuXG4gICAgUHJvbWlzZS5tYXBTZXJpZXMoT2JqZWN0LmtleXMob3B0aW9ucy51ZGFzKSwgKHVkYUtleSkgPT4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgY29uc3QgdWRhQ2FsbGJhY2sgPSAoZXJyKSA9PiB7XG4gICAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgICByZWplY3QoZXJyKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgcmVzb2x2ZSgpO1xuICAgICAgfTtcblxuICAgICAgdWRhQnVpbGRlci52YWxpZGF0ZV9kZWZpbml0aW9uKHVkYUtleSwgb3B0aW9ucy51ZGFzW3VkYUtleV0pO1xuXG4gICAgICBpZiAoIW9wdGlvbnMudWRhc1t1ZGFLZXldLmluaXRjb25kKSB7XG4gICAgICAgIG9wdGlvbnMudWRhc1t1ZGFLZXldLmluaXRjb25kID0gbnVsbDtcbiAgICAgIH1cblxuICAgICAgdWRhQnVpbGRlci5nZXRfdWRhKHVkYUtleSwga2V5c3BhY2UsIChlcnIsIHVkYU9iamVjdHMpID0+IHtcbiAgICAgICAgaWYgKGVycikge1xuICAgICAgICAgIHVkYUNhbGxiYWNrKGVycik7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCF1ZGFPYmplY3RzKSB7XG4gICAgICAgICAgdWRhQnVpbGRlci5jcmVhdGVfdWRhKHVkYUtleSwgb3B0aW9ucy51ZGFzW3VkYUtleV0sIHVkYUNhbGxiYWNrKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBpbnB1dFR5cGVzID0gXy5tYXAob3B0aW9ucy51ZGFzW3VkYUtleV0uaW5wdXRfdHlwZXMsIG5vcm1hbGl6ZXIubm9ybWFsaXplX3VzZXJfZGVmaW5lZF90eXBlKTtcbiAgICAgICAgY29uc3Qgc2Z1bmMgPSBvcHRpb25zLnVkYXNbdWRhS2V5XS5zZnVuYy50b0xvd2VyQ2FzZSgpO1xuICAgICAgICBjb25zdCBzdHlwZSA9IG5vcm1hbGl6ZXIubm9ybWFsaXplX3VzZXJfZGVmaW5lZF90eXBlKG9wdGlvbnMudWRhc1t1ZGFLZXldLnN0eXBlKTtcbiAgICAgICAgY29uc3QgZmluYWxmdW5jID0gb3B0aW9ucy51ZGFzW3VkYUtleV0uZmluYWxmdW5jID8gb3B0aW9ucy51ZGFzW3VkYUtleV0uZmluYWxmdW5jLnRvTG93ZXJDYXNlKCkgOiBudWxsO1xuICAgICAgICBjb25zdCBpbml0Y29uZCA9IG9wdGlvbnMudWRhc1t1ZGFLZXldLmluaXRjb25kID8gb3B0aW9ucy51ZGFzW3VkYUtleV0uaW5pdGNvbmQucmVwbGFjZSgvW1xcc10vZywgJycpIDogbnVsbDtcblxuICAgICAgICBmb3IgKGxldCBpID0gMDsgaSA8IHVkYU9iamVjdHMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgICBjb25zdCByZXN1bHRBcmd1bWVudFR5cGVzID0gXy5tYXAodWRhT2JqZWN0c1tpXS5hcmd1bWVudF90eXBlcywgbm9ybWFsaXplci5ub3JtYWxpemVfdXNlcl9kZWZpbmVkX3R5cGUpO1xuXG4gICAgICAgICAgY29uc3QgcmVzdWx0U3RhdGVGdW5jID0gdWRhT2JqZWN0c1tpXS5zdGF0ZV9mdW5jO1xuICAgICAgICAgIGNvbnN0IHJlc3VsdFN0YXRlVHlwZSA9IG5vcm1hbGl6ZXIubm9ybWFsaXplX3VzZXJfZGVmaW5lZF90eXBlKHVkYU9iamVjdHNbaV0uc3RhdGVfdHlwZSk7XG4gICAgICAgICAgY29uc3QgcmVzdWx0RmluYWxGdW5jID0gdWRhT2JqZWN0c1tpXS5maW5hbF9mdW5jO1xuICAgICAgICAgIGNvbnN0IHJlc3VsdEluaXRjb25kID0gdWRhT2JqZWN0c1tpXS5pbml0Y29uZCA/IHVkYU9iamVjdHNbaV0uaW5pdGNvbmQucmVwbGFjZSgvW1xcc10vZywgJycpIDogbnVsbDtcblxuICAgICAgICAgIGlmIChzZnVuYyA9PT0gcmVzdWx0U3RhdGVGdW5jICYmXG4gICAgICAgICAgICBzdHlwZSA9PT0gcmVzdWx0U3RhdGVUeXBlICYmXG4gICAgICAgICAgICBmaW5hbGZ1bmMgPT09IHJlc3VsdEZpbmFsRnVuYyAmJlxuICAgICAgICAgICAgaW5pdGNvbmQgPT09IHJlc3VsdEluaXRjb25kICYmXG4gICAgICAgICAgICBfLmlzRXF1YWwoaW5wdXRUeXBlcywgcmVzdWx0QXJndW1lbnRUeXBlcykpIHtcbiAgICAgICAgICAgIHVkYUNhbGxiYWNrKCk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIHVkYUJ1aWxkZXIuY3JlYXRlX3VkYSh1ZGFLZXksIG9wdGlvbnMudWRhc1t1ZGFLZXldLCB1ZGFDYWxsYmFjayk7XG4gICAgICB9KTtcbiAgICB9KSlcbiAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgY2FsbGJhY2soKTtcbiAgICAgIH0pXG4gICAgICAuY2F0Y2goKGVycikgPT4ge1xuICAgICAgICBjYWxsYmFjayhlcnIpO1xuICAgICAgfSk7XG4gIH0sXG5cbiAgX3NldF9jbGllbnQoY2xpZW50KSB7XG4gICAgY29uc3QgZGVmaW5lQ29ubmVjdGlvbk9wdGlvbnMgPSBfLmNsb25lRGVlcCh0aGlzLl9jb25uZWN0aW9uKTtcblxuICAgIHRoaXMuX2NsaWVudCA9IGNsaWVudDtcbiAgICB0aGlzLl9kZWZpbmVfY29ubmVjdGlvbiA9IG5ldyBjcWwuQ2xpZW50KGRlZmluZUNvbm5lY3Rpb25PcHRpb25zKTtcblxuICAgIC8vIFJlc2V0IGNvbm5lY3Rpb25zIG9uIGFsbCBtb2RlbHNcbiAgICBPYmplY3Qua2V5cyh0aGlzLl9tb2RlbHMpLmZvckVhY2goKGkpID0+IHtcbiAgICAgIHRoaXMuX21vZGVsc1tpXS5fcHJvcGVydGllcy5jcWwgPSB0aGlzLl9jbGllbnQ7XG4gICAgICB0aGlzLl9tb2RlbHNbaV0uX3Byb3BlcnRpZXMuZGVmaW5lX2Nvbm5lY3Rpb24gPSB0aGlzLl9kZWZpbmVfY29ubmVjdGlvbjtcbiAgICB9KTtcbiAgfSxcblxuICBpbml0KGNhbGxiYWNrKSB7XG4gICAgY29uc3Qgb25Vc2VyRGVmaW5lZEFnZ3JlZ2F0ZXMgPSAoZXJyKSA9PiB7XG4gICAgICBpZiAoZXJyKSB7XG4gICAgICAgIGNhbGxiYWNrKGVycik7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgY29uc3QgbWFuYWdlbWVudFRhc2tzID0gW107XG4gICAgICBpZiAodGhpcy5fa2V5c3BhY2UgJiYgdGhpcy5fb3B0aW9ucy5tYW5hZ2VFU0luZGV4KSB7XG4gICAgICAgIHRoaXMuYXNzZXJ0RVNJbmRleEFzeW5jID0gUHJvbWlzZS5wcm9taXNpZnkodGhpcy5fYXNzZXJ0X2VzX2luZGV4KTtcbiAgICAgICAgbWFuYWdlbWVudFRhc2tzLnB1c2godGhpcy5hc3NlcnRFU0luZGV4QXN5bmMoKSk7XG4gICAgICB9XG4gICAgICBpZiAodGhpcy5fa2V5c3BhY2UgJiYgdGhpcy5fb3B0aW9ucy5tYW5hZ2VHcmFwaHMpIHtcbiAgICAgICAgdGhpcy5hc3NlcnRHcmVtbGluR3JhcGhBc3luYyA9IFByb21pc2UucHJvbWlzaWZ5KHRoaXMuX2Fzc2VydF9ncmVtbGluX2dyYXBoKTtcbiAgICAgICAgbWFuYWdlbWVudFRhc2tzLnB1c2godGhpcy5hc3NlcnRHcmVtbGluR3JhcGhBc3luYygpKTtcbiAgICAgIH1cbiAgICAgIFByb21pc2UuYWxsKG1hbmFnZW1lbnRUYXNrcylcbiAgICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICAgIGNhbGxiYWNrKG51bGwsIHRoaXMpO1xuICAgICAgICB9KVxuICAgICAgICAuY2F0Y2goKGVycjEpID0+IHtcbiAgICAgICAgICBjYWxsYmFjayhlcnIxKTtcbiAgICAgICAgfSk7XG4gICAgfTtcblxuICAgIGNvbnN0IG9uVXNlckRlZmluZWRGdW5jdGlvbnMgPSBmdW5jdGlvbiBmKGVycikge1xuICAgICAgaWYgKGVycikge1xuICAgICAgICBjYWxsYmFjayhlcnIpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICB0cnkge1xuICAgICAgICB0aGlzLl9hc3NlcnRfdXNlcl9kZWZpbmVkX2FnZ3JlZ2F0ZXMob25Vc2VyRGVmaW5lZEFnZ3JlZ2F0ZXMuYmluZCh0aGlzKSk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC52YWxpZGF0b3IuaW52YWxpZHVkYScsIGUubWVzc2FnZSkpO1xuICAgICAgfVxuICAgIH07XG5cbiAgICBjb25zdCBvblVzZXJEZWZpbmVkVHlwZXMgPSBmdW5jdGlvbiBmKGVycikge1xuICAgICAgaWYgKGVycikge1xuICAgICAgICBjYWxsYmFjayhlcnIpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICB0cnkge1xuICAgICAgICB0aGlzLl9hc3NlcnRfdXNlcl9kZWZpbmVkX2Z1bmN0aW9ucyhvblVzZXJEZWZpbmVkRnVuY3Rpb25zLmJpbmQodGhpcykpO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwudmFsaWRhdG9yLmludmFsaWR1ZGYnLCBlLm1lc3NhZ2UpKTtcbiAgICAgIH1cbiAgICB9O1xuXG4gICAgY29uc3Qgb25LZXlzcGFjZSA9IGZ1bmN0aW9uIGYoZXJyKSB7XG4gICAgICBpZiAoZXJyKSB7XG4gICAgICAgIGNhbGxiYWNrKGVycik7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIHRoaXMuX3NldF9jbGllbnQobmV3IGNxbC5DbGllbnQodGhpcy5fY29ubmVjdGlvbikpO1xuICAgICAgdHJ5IHtcbiAgICAgICAgdGhpcy5fYXNzZXJ0X3VzZXJfZGVmaW5lZF90eXBlcyhvblVzZXJEZWZpbmVkVHlwZXMuYmluZCh0aGlzKSk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC52YWxpZGF0b3IuaW52YWxpZHVkdCcsIGUubWVzc2FnZSkpO1xuICAgICAgfVxuICAgIH07XG5cbiAgICBpZiAodGhpcy5fa2V5c3BhY2UgJiYgdGhpcy5fb3B0aW9ucy5jcmVhdGVLZXlzcGFjZSAhPT0gZmFsc2UpIHtcbiAgICAgIHRoaXMuX2Fzc2VydF9rZXlzcGFjZShvbktleXNwYWNlLmJpbmQodGhpcykpO1xuICAgIH0gZWxzZSB7XG4gICAgICBvbktleXNwYWNlLmNhbGwodGhpcyk7XG4gICAgfVxuICB9LFxuXG4gIGFkZE1vZGVsKG1vZGVsTmFtZSwgbW9kZWxTY2hlbWEpIHtcbiAgICBpZiAoIW1vZGVsTmFtZSB8fCB0eXBlb2YgKG1vZGVsTmFtZSkgIT09ICdzdHJpbmcnKSB7XG4gICAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwudmFsaWRhdG9yLmludmFsaWRzY2hlbWEnLCAnTW9kZWwgbmFtZSBtdXN0IGJlIGEgdmFsaWQgc3RyaW5nJykpO1xuICAgIH1cblxuICAgIHRyeSB7XG4gICAgICBzY2hlbWVyLnZhbGlkYXRlX21vZGVsX3NjaGVtYShtb2RlbFNjaGVtYSk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLnZhbGlkYXRvci5pbnZhbGlkc2NoZW1hJywgZS5tZXNzYWdlKSk7XG4gICAgfVxuXG4gICAgaWYgKG1vZGVsU2NoZW1hLm9wdGlvbnMgJiYgbW9kZWxTY2hlbWEub3B0aW9ucy50aW1lc3RhbXBzKSB7XG4gICAgICBjb25zdCB0aW1lc3RhbXBPcHRpb25zID0ge1xuICAgICAgICBjcmVhdGVkQXQ6IG1vZGVsU2NoZW1hLm9wdGlvbnMudGltZXN0YW1wcy5jcmVhdGVkQXQgfHwgJ2NyZWF0ZWRBdCcsXG4gICAgICAgIHVwZGF0ZWRBdDogbW9kZWxTY2hlbWEub3B0aW9ucy50aW1lc3RhbXBzLnVwZGF0ZWRBdCB8fCAndXBkYXRlZEF0JyxcbiAgICAgIH07XG4gICAgICBtb2RlbFNjaGVtYS5vcHRpb25zLnRpbWVzdGFtcHMgPSB0aW1lc3RhbXBPcHRpb25zO1xuXG4gICAgICBtb2RlbFNjaGVtYS5maWVsZHNbbW9kZWxTY2hlbWEub3B0aW9ucy50aW1lc3RhbXBzLmNyZWF0ZWRBdF0gPSB7XG4gICAgICAgIHR5cGU6ICd0aW1lc3RhbXAnLFxuICAgICAgICBkZWZhdWx0OiB7XG4gICAgICAgICAgJGRiX2Z1bmN0aW9uOiAndG9UaW1lc3RhbXAobm93KCkpJyxcbiAgICAgICAgfSxcbiAgICAgIH07XG4gICAgICBtb2RlbFNjaGVtYS5maWVsZHNbbW9kZWxTY2hlbWEub3B0aW9ucy50aW1lc3RhbXBzLnVwZGF0ZWRBdF0gPSB7XG4gICAgICAgIHR5cGU6ICd0aW1lc3RhbXAnLFxuICAgICAgICBkZWZhdWx0OiB7XG4gICAgICAgICAgJGRiX2Z1bmN0aW9uOiAndG9UaW1lc3RhbXAobm93KCkpJyxcbiAgICAgICAgfSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgaWYgKG1vZGVsU2NoZW1hLm9wdGlvbnMgJiYgbW9kZWxTY2hlbWEub3B0aW9ucy52ZXJzaW9ucykge1xuICAgICAgY29uc3QgdmVyc2lvbk9wdGlvbnMgPSB7XG4gICAgICAgIGtleTogbW9kZWxTY2hlbWEub3B0aW9ucy52ZXJzaW9ucy5rZXkgfHwgJ19fdicsXG4gICAgICB9O1xuICAgICAgbW9kZWxTY2hlbWEub3B0aW9ucy52ZXJzaW9ucyA9IHZlcnNpb25PcHRpb25zO1xuXG4gICAgICBtb2RlbFNjaGVtYS5maWVsZHNbbW9kZWxTY2hlbWEub3B0aW9ucy52ZXJzaW9ucy5rZXldID0ge1xuICAgICAgICB0eXBlOiAndGltZXV1aWQnLFxuICAgICAgICBkZWZhdWx0OiB7XG4gICAgICAgICAgJGRiX2Z1bmN0aW9uOiAnbm93KCknLFxuICAgICAgICB9LFxuICAgICAgfTtcbiAgICB9XG5cbiAgICBjb25zdCBiYXNlUHJvcGVydGllcyA9IHtcbiAgICAgIG5hbWU6IG1vZGVsTmFtZSxcbiAgICAgIHNjaGVtYTogbW9kZWxTY2hlbWEsXG4gICAgICBrZXlzcGFjZTogdGhpcy5fa2V5c3BhY2UsXG4gICAgICBkZWZpbmVfY29ubmVjdGlvbjogdGhpcy5fZGVmaW5lX2Nvbm5lY3Rpb24sXG4gICAgICBjcWw6IHRoaXMuX2NsaWVudCxcbiAgICAgIGVzY2xpZW50OiB0aGlzLl9lc2NsaWVudCxcbiAgICAgIGdyZW1saW5fY2xpZW50OiB0aGlzLl9ncmVtbGluX2NsaWVudCxcbiAgICAgIGdldF9jb25zdHJ1Y3RvcjogdGhpcy5nZXRNb2RlbC5iaW5kKHRoaXMsIG1vZGVsTmFtZSksXG4gICAgICBpbml0OiB0aGlzLmluaXQuYmluZCh0aGlzKSxcbiAgICAgIGRyb3BUYWJsZU9uU2NoZW1hQ2hhbmdlOiB0aGlzLl9vcHRpb25zLmRyb3BUYWJsZU9uU2NoZW1hQ2hhbmdlLFxuICAgICAgY3JlYXRlVGFibGU6IHRoaXMuX29wdGlvbnMuY3JlYXRlVGFibGUsXG4gICAgICBtaWdyYXRpb246IHRoaXMuX29wdGlvbnMubWlncmF0aW9uLFxuICAgICAgZGlzYWJsZVRUWUNvbmZpcm1hdGlvbjogdGhpcy5fb3B0aW9ucy5kaXNhYmxlVFRZQ29uZmlybWF0aW9uLFxuICAgIH07XG5cbiAgICB0aGlzLl9tb2RlbHNbbW9kZWxOYW1lXSA9IHRoaXMuX2dlbmVyYXRlX21vZGVsKGJhc2VQcm9wZXJ0aWVzKTtcbiAgICByZXR1cm4gdGhpcy5fbW9kZWxzW21vZGVsTmFtZV07XG4gIH0sXG5cbiAgZ2V0TW9kZWwobW9kZWxOYW1lKSB7XG4gICAgcmV0dXJuIHRoaXMuX21vZGVsc1ttb2RlbE5hbWVdIHx8IG51bGw7XG4gIH0sXG5cbiAgY2xvc2UoY2FsbGJhY2spIHtcbiAgICBjYWxsYmFjayA9IGNhbGxiYWNrIHx8IG5vb3A7XG5cbiAgICBpZiAodGhpcy5vcm0uX2VzY2xpZW50KSB7XG4gICAgICB0aGlzLm9ybS5fZXNjbGllbnQuY2xvc2UoKTtcbiAgICB9XG5cbiAgICBpZiAodGhpcy5vcm0uX2dyZW1saW5fY2xpZW50ICYmIHRoaXMub3JtLl9ncmVtbGluX2NsaWVudC5jb25uZWN0aW9uICYmIHRoaXMub3JtLl9ncmVtbGluX2NsaWVudC5jb25uZWN0aW9uLndzKSB7XG4gICAgICB0aGlzLm9ybS5fZ3JlbWxpbl9jbGllbnQuY29ubmVjdGlvbi53cy5jbG9zZSgpO1xuICAgIH1cblxuICAgIGNvbnN0IGNsaWVudHNUb1NodXRkb3duID0gW107XG4gICAgaWYgKHRoaXMub3JtLl9jbGllbnQpIHtcbiAgICAgIGNsaWVudHNUb1NodXRkb3duLnB1c2godGhpcy5vcm0uX2NsaWVudC5zaHV0ZG93bigpKTtcbiAgICB9XG4gICAgaWYgKHRoaXMub3JtLl9kZWZpbmVfY29ubmVjdGlvbikge1xuICAgICAgY2xpZW50c1RvU2h1dGRvd24ucHVzaCh0aGlzLm9ybS5fZGVmaW5lX2Nvbm5lY3Rpb24uc2h1dGRvd24oKSk7XG4gICAgfVxuXG4gICAgUHJvbWlzZS5hbGwoY2xpZW50c1RvU2h1dGRvd24pXG4gICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgIGNhbGxiYWNrKCk7XG4gICAgICB9KVxuICAgICAgLmNhdGNoKChlcnIpID0+IHtcbiAgICAgICAgY2FsbGJhY2soZXJyKTtcbiAgICAgIH0pO1xuICB9LFxufTtcblxubW9kdWxlLmV4cG9ydHMgPSBBcG9sbG87XG4iXX0=