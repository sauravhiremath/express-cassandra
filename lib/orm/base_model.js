'use strict';

var Promise = require('bluebird');
var _ = require('lodash');
var util = require('util');

var dseDriver = void 0;
try {
  // eslint-disable-next-line import/no-extraneous-dependencies, import/no-unresolved
  dseDriver = require('dse-driver');
} catch (e) {
  dseDriver = null;
}

var cql = Promise.promisifyAll(dseDriver || require('cassandra-driver'));

var buildError = require('./apollo_error.js');
var schemer = require('../validators/schema');
var normalizer = require('../utils/normalizer');
var parser = require('../utils/parser');

var TableBuilder = require('../builders/table');
var ElassandraBuilder = require('../builders/elassandra');
var JanusGraphBuilder = require('../builders/janusgraph');
var Driver = require('../helpers/driver');

var BaseModel = function f(instanceValues) {
  instanceValues = instanceValues || {};
  var fieldValues = {};
  var fields = this.constructor._properties.schema.fields;
  var methods = this.constructor._properties.schema.methods || {};
  var model = this;

  var defaultSetter = function f1(propName, newValue) {
    if (this[propName] !== newValue) {
      model._modified[propName] = true;
    }
    this[propName] = newValue;
  };

  var defaultGetter = function f1(propName) {
    return this[propName];
  };

  this._modified = {};
  this._validators = {};

  for (var fieldsKeys = Object.keys(fields), i = 0, len = fieldsKeys.length; i < len; i++) {
    var propertyName = fieldsKeys[i];
    var field = fields[fieldsKeys[i]];

    try {
      this._validators[propertyName] = schemer.get_validators(this.constructor._properties.schema, propertyName);
    } catch (e) {
      throw buildError('model.validator.invalidschema', e.message);
    }

    var setter = defaultSetter.bind(fieldValues, propertyName);
    var getter = defaultGetter.bind(fieldValues, propertyName);

    if (field.virtual && typeof field.virtual.set === 'function') {
      setter = field.virtual.set.bind(fieldValues);
    }

    if (field.virtual && typeof field.virtual.get === 'function') {
      getter = field.virtual.get.bind(fieldValues);
    }

    var descriptor = {
      enumerable: true,
      set: setter,
      get: getter
    };

    Object.defineProperty(this, propertyName, descriptor);
    if (field.virtual && typeof instanceValues[propertyName] !== 'undefined') {
      this[propertyName] = instanceValues[propertyName];
    }
  }

  for (var _fieldsKeys = Object.keys(fields), _i = 0, _len = _fieldsKeys.length; _i < _len; _i++) {
    var _propertyName = _fieldsKeys[_i];
    var _field = fields[_fieldsKeys[_i]];

    if (!_field.virtual && typeof instanceValues[_propertyName] !== 'undefined') {
      this[_propertyName] = instanceValues[_propertyName];
    }
  }

  for (var methodNames = Object.keys(methods), _i2 = 0, _len2 = methodNames.length; _i2 < _len2; _i2++) {
    var methodName = methodNames[_i2];
    var method = methods[methodName];
    this[methodName] = method;
  }
};

BaseModel._properties = {
  name: null,
  schema: null
};

BaseModel._set_properties = function f(properties) {
  var schema = properties.schema;
  var tableName = schema.table_name || properties.name;

  if (!schemer.validate_table_name(tableName)) {
    throw buildError('model.tablecreation.invalidname', tableName);
  }

  var qualifiedTableName = util.format('"%s"."%s"', properties.keyspace, tableName);

  this._properties = properties;
  this._properties.table_name = tableName;
  this._properties.qualified_table_name = qualifiedTableName;
  this._driver = new Driver(this._properties);
};

BaseModel._sync_model_definition = function f(callback) {
  var properties = this._properties;
  var tableName = properties.table_name;
  var modelSchema = properties.schema;
  var migration = properties.migration;

  var tableBuilder = new TableBuilder(this._driver, this._properties);

  // backwards compatible change, dropTableOnSchemaChange will work like migration: 'drop'
  if (!migration) {
    if (properties.dropTableOnSchemaChange) migration = 'drop';else migration = 'safe';
  }
  // always safe migrate if NODE_ENV==='production'
  if (process.env.NODE_ENV === 'production') migration = 'safe';

  // check for existence of table on DB and if it matches this model's schema
  tableBuilder.get_table_schema(function (err, dbSchema) {
    if (err) {
      callback(err);
      return;
    }

    var afterDBCreate = function afterDBCreate(err1) {
      if (err1) {
        callback(err1);
        return;
      }

      var indexingTasks = [];

      // cassandra index create if defined
      if (_.isArray(modelSchema.indexes)) {
        tableBuilder.createIndexesAsync = Promise.promisify(tableBuilder.create_indexes);
        indexingTasks.push(tableBuilder.createIndexesAsync(modelSchema.indexes));
      }
      // cassandra custom index create if defined
      if (_.isArray(modelSchema.custom_indexes)) {
        tableBuilder.createCustomIndexesAsync = Promise.promisify(tableBuilder.create_custom_indexes);
        indexingTasks.push(tableBuilder.createCustomIndexesAsync(modelSchema.custom_indexes));
      }
      if (modelSchema.custom_index) {
        tableBuilder.createCustomIndexAsync = Promise.promisify(tableBuilder.create_custom_indexes);
        indexingTasks.push(tableBuilder.createCustomIndexAsync([modelSchema.custom_index]));
      }
      // materialized view create if defined
      if (modelSchema.materialized_views) {
        tableBuilder.createViewsAsync = Promise.promisify(tableBuilder.create_mviews);
        indexingTasks.push(tableBuilder.createViewsAsync(modelSchema.materialized_views));
      }

      Promise.all(indexingTasks).then(function () {
        // db schema was updated, so callback with true
        callback(null, true);
      }).catch(function (err2) {
        callback(err2);
      });
    };

    if (!dbSchema) {
      if (properties.createTable === false) {
        callback(buildError('model.tablecreation.schemanotfound', tableName));
        return;
      }
      // if not existing, it's created
      tableBuilder.create_table(modelSchema, afterDBCreate);
      return;
    }

    var normalizedModelSchema = void 0;
    var normalizedDBSchema = void 0;

    try {
      normalizedModelSchema = normalizer.normalize_model_schema(modelSchema);
      normalizedDBSchema = normalizer.normalize_model_schema(dbSchema);
    } catch (e) {
      throw buildError('model.validator.invalidschema', e.message);
    }

    if (_.isEqual(normalizedModelSchema, normalizedDBSchema)) {
      // no change in db was made, so callback with false
      callback(null, false);
      return;
    }

    if (migration === 'alter') {
      // check if table can be altered to match schema
      if (_.isEqual(normalizedModelSchema.key, normalizedDBSchema.key) && _.isEqual(normalizedModelSchema.clustering_order, normalizedDBSchema.clustering_order)) {
        tableBuilder.init_alter_operations(modelSchema, dbSchema, normalizedModelSchema, normalizedDBSchema, function (err1) {
          if (err1 && err1.message === 'alter_impossible') {
            tableBuilder.drop_recreate_table(modelSchema, normalizedDBSchema.materialized_views, afterDBCreate);
            return;
          }
          callback(err1);
        });
      } else {
        tableBuilder.drop_recreate_table(modelSchema, normalizedDBSchema.materialized_views, afterDBCreate);
      }
    } else if (migration === 'drop') {
      tableBuilder.drop_recreate_table(modelSchema, normalizedDBSchema.materialized_views, afterDBCreate);
    } else {
      callback(buildError('model.tablecreation.schemamismatch', tableName, 'migration suspended, please apply the change manually'));
    }
  });
};

BaseModel._sync_es_index = function f(callback) {
  var properties = this._properties;

  if (properties.esclient && properties.schema.es_index_mapping) {
    var keyspaceName = properties.keyspace;
    var mappingName = properties.table_name;
    var indexName = `${keyspaceName}_${mappingName}`;

    var elassandraBuilder = new ElassandraBuilder(properties.esclient);
    elassandraBuilder.assert_index(keyspaceName, indexName, function (err) {
      if (err) {
        callback(err);
        return;
      }
      elassandraBuilder.put_mapping(indexName, mappingName, properties.schema.es_index_mapping, callback);
    });
    return;
  }
  callback();
};

BaseModel._sync_graph = function f(callback) {
  var properties = this._properties;

  if (properties.gremlin_client && properties.schema.graph_mapping) {
    var graphName = `${properties.keyspace}_graph`;
    var mappingName = properties.table_name;

    var graphBuilder = new JanusGraphBuilder(properties.gremlin_client);
    graphBuilder.assert_graph(graphName, function (err) {
      if (err) {
        callback(err);
        return;
      }
      graphBuilder.put_mapping(graphName, mappingName, properties.schema.graph_mapping, callback);
    });
    return;
  }
  callback();
};

BaseModel._execute_table_query = function f(query, params, options, callback) {
  if (arguments.length === 3) {
    callback = options;
    options = {};
  }

  var defaults = {
    prepare: true
  };

  options = _.defaultsDeep(options, defaults);

  var doExecuteQuery = function f1(doquery, docallback) {
    this.execute_query(doquery, params, options, docallback);
  }.bind(this, query);

  if (this.is_table_ready()) {
    doExecuteQuery(callback);
  } else {
    this.init(function (err) {
      if (err) {
        callback(err);
        return;
      }
      doExecuteQuery(callback);
    });
  }
};

BaseModel.get_find_query = function f(queryObject, options) {
  var orderbyClause = parser.get_orderby_clause(queryObject);
  var limitClause = parser.get_limit_clause(queryObject);
  var whereClause = parser.get_where_clause(this._properties.schema, queryObject);
  var selectClause = parser.get_select_clause(options);
  var groupbyClause = parser.get_groupby_clause(options);

  var query = util.format('SELECT %s%s FROM "%s"', options.distinct ? 'DISTINCT ' : '', selectClause, options.materialized_view ? options.materialized_view : this._properties.table_name);

  if (whereClause.query) query += util.format(' %s', whereClause.query);
  if (orderbyClause) query += util.format(' %s', orderbyClause);
  if (groupbyClause) query += util.format(' %s', groupbyClause);
  if (limitClause) query += util.format(' %s', limitClause);
  if (options.allow_filtering) query += ' ALLOW FILTERING';

  query += ';';

  return { query, params: whereClause.params };
};

BaseModel.get_table_name = function f() {
  return this._properties.table_name;
};

BaseModel.get_keyspace_name = function f() {
  return this._properties.keyspace;
};

BaseModel.is_table_ready = function f() {
  return this._ready === true;
};

BaseModel.init = function f(options, callback) {
  if (!callback) {
    callback = options;
    options = undefined;
  }

  this._ready = true;
  callback();
};

BaseModel.syncDB = function f(callback) {
  var _this = this;

  this._sync_model_definition(function (err, result) {
    if (err) {
      callback(err);
      return;
    }

    _this._sync_es_index(function (err1) {
      if (err1) {
        callback(err1);
        return;
      }

      _this._sync_graph(function (err2) {
        if (err2) {
          callback(err2);
          return;
        }

        _this._ready = true;
        callback(null, result);
      });
    });
  });
};

BaseModel.get_cql_client = function f(callback) {
  var _this2 = this;

  this._driver.ensure_init(function (err) {
    if (err) {
      callback(err);
      return;
    }
    callback(null, _this2._properties.cql);
  });
};

BaseModel.get_es_client = function f() {
  if (!this._properties.esclient) {
    throw new Error('To use elassandra features, set `manageESIndex` to true in ormOptions');
  }
  return this._properties.esclient;
};

BaseModel.get_gremlin_client = function f() {
  if (!this._properties.gremlin_client) {
    throw new Error('To use janus graph features, set `manageGraphs` to true in ormOptions');
  }
  return this._properties.gremlin_client;
};

BaseModel.execute_query = function f() {
  var _driver;

  (_driver = this._driver).execute_query.apply(_driver, arguments);
};

BaseModel.execute_batch = function f() {
  var _driver2;

  (_driver2 = this._driver).execute_batch.apply(_driver2, arguments);
};

BaseModel.execute_eachRow = function f() {
  var _driver3;

  (_driver3 = this._driver).execute_eachRow.apply(_driver3, arguments);
};

BaseModel._execute_table_eachRow = function f(query, params, options, onReadable, callback) {
  var _this3 = this;

  if (this.is_table_ready()) {
    this.execute_eachRow(query, params, options, onReadable, callback);
  } else {
    this.init(function (err) {
      if (err) {
        callback(err);
        return;
      }
      _this3.execute_eachRow(query, params, options, onReadable, callback);
    });
  }
};

BaseModel.eachRow = function f(queryObject, options, onReadable, callback) {
  var _this4 = this;

  if (arguments.length === 3) {
    var cb = onReadable;
    onReadable = options;
    callback = cb;
    options = {};
  }
  if (typeof onReadable !== 'function') {
    throw buildError('model.find.eachrowerror', 'no valid onReadable function was provided');
  }
  if (typeof callback !== 'function') {
    throw buildError('model.find.cberror');
  }

  var defaults = {
    raw: false,
    prepare: true
  };

  options = _.defaultsDeep(options, defaults);

  options.return_query = true;
  var selectQuery = this.find(queryObject, options);

  var queryOptions = normalizer.normalize_query_option(options);

  this._execute_table_eachRow(selectQuery.query, selectQuery.params, queryOptions, function (n, row) {
    if (!options.raw) {
      var ModelConstructor = _this4._properties.get_constructor();
      row = new ModelConstructor(row);
      row._modified = {};
    }
    onReadable(n, row);
  }, function (err, result) {
    if (err) {
      callback(buildError('model.find.dberror', err));
      return;
    }
    callback(err, result);
  });
};

BaseModel.execute_stream = function f() {
  var _driver4;

  (_driver4 = this._driver).execute_stream.apply(_driver4, arguments);
};

BaseModel._execute_table_stream = function f(query, params, options, onReadable, callback) {
  var _this5 = this;

  if (this.is_table_ready()) {
    this.execute_stream(query, params, options, onReadable, callback);
  } else {
    this.init(function (err) {
      if (err) {
        callback(err);
        return;
      }
      _this5.execute_stream(query, params, options, onReadable, callback);
    });
  }
};

BaseModel.stream = function f(queryObject, options, onReadable, callback) {
  if (arguments.length === 3) {
    var cb = onReadable;
    onReadable = options;
    callback = cb;
    options = {};
  }

  if (typeof onReadable !== 'function') {
    throw buildError('model.find.streamerror', 'no valid onReadable function was provided');
  }
  if (typeof callback !== 'function') {
    throw buildError('model.find.cberror');
  }

  var defaults = {
    raw: false,
    prepare: true
  };

  options = _.defaultsDeep(options, defaults);

  options.return_query = true;
  var selectQuery = this.find(queryObject, options);

  var queryOptions = normalizer.normalize_query_option(options);

  var self = this;

  this._execute_table_stream(selectQuery.query, selectQuery.params, queryOptions, function f1() {
    var reader = this;
    reader.readRow = function () {
      var row = reader.read();
      if (!row) return row;
      if (!options.raw) {
        var ModelConstructor = self._properties.get_constructor();
        var o = new ModelConstructor(row);
        o._modified = {};
        return o;
      }
      return row;
    };
    onReadable(reader);
  }, function (err) {
    if (err) {
      callback(buildError('model.find.dberror', err));
      return;
    }
    callback();
  });
};

BaseModel._execute_gremlin_query = function f(script, bindings, callback) {
  var gremlinClient = this.get_gremlin_client();
  gremlinClient.execute(script, bindings, function (err, results) {
    if (err) {
      callback(err);
      return;
    }
    callback(null, results);
  });
};

BaseModel._execute_gremlin_script = function f(script, bindings, callback) {
  this._execute_gremlin_query(script, bindings, function (err, results) {
    if (err) {
      callback(err);
      return;
    }
    callback(null, results[0]);
  });
};

BaseModel.createVertex = function f(vertexProperties, callback) {
  var properties = this._properties;
  var __graphName = `${properties.keyspace}_graph`;
  var __vertexLabel = properties.table_name;
  var script = `
    graph = ConfiguredGraphFactory.open(__graphName);
    vertex = graph.addVertex(__vertexLabel);
  `;
  Object.keys(vertexProperties).forEach(function (property) {
    script += `vertex.property('${property}', ${property});`;
  });
  script += 'vertex';
  var bindings = _.defaults(vertexProperties, {
    __graphName,
    __vertexLabel
  });
  this._execute_gremlin_script(script, bindings, callback);
};

BaseModel.getVertex = function f(__vertexId, callback) {
  var properties = this._properties;
  var __graphName = `${properties.keyspace}_graph`;
  var script = `
    graph = ConfiguredGraphFactory.open(__graphName);
    g = graph.traversal();
    vertex = g.V(__vertexId);
  `;
  var bindings = {
    __graphName,
    __vertexId
  };
  this._execute_gremlin_script(script, bindings, callback);
};

BaseModel.updateVertex = function f(__vertexId, vertexProperties, callback) {
  var properties = this._properties;
  var __graphName = `${properties.keyspace}_graph`;
  var script = `
    graph = ConfiguredGraphFactory.open(__graphName);
    g = graph.traversal();
    vertex = g.V(__vertexId);
  `;
  Object.keys(vertexProperties).forEach(function (property) {
    script += `vertex.property('${property}', ${property});`;
  });
  script += 'vertex';
  var bindings = _.defaults(vertexProperties, {
    __graphName,
    __vertexId
  });
  this._execute_gremlin_script(script, bindings, callback);
};

BaseModel.deleteVertex = function f(__vertexId, callback) {
  var properties = this._properties;
  var __graphName = `${properties.keyspace}_graph`;
  var script = `
    graph = ConfiguredGraphFactory.open(__graphName);
    g = graph.traversal();
    vertex = g.V(__vertexId);
    vertex.drop();
  `;
  var bindings = {
    __graphName,
    __vertexId
  };
  this._execute_gremlin_script(script, bindings, callback);
};

BaseModel.createEdge = function f(__edgeLabel, __fromVertexId, __toVertexId, edgeProperties, callback) {
  if (arguments.length === 4 && typeof edgeProperties === 'function') {
    callback = edgeProperties;
    edgeProperties = {};
  }
  var properties = this._properties;
  var __graphName = `${properties.keyspace}_graph`;
  var script = `
    graph = ConfiguredGraphFactory.open(__graphName);
    g = graph.traversal();
    fromVertex = g.V(__fromVertexId).next();
    toVertex = g.V(__toVertexId).next();
    edge = fromVertex.addEdge(__edgeLabel, toVertex);
  `;
  Object.keys(edgeProperties).forEach(function (property) {
    script += `edge.property('${property}', ${property});`;
  });
  script += 'edge';
  var bindings = _.defaults(edgeProperties, {
    __graphName,
    __fromVertexId,
    __toVertexId,
    __edgeLabel
  });
  this._execute_gremlin_script(script, bindings, callback);
};

BaseModel.getEdge = function f(__edgeId, callback) {
  var properties = this._properties;
  var __graphName = `${properties.keyspace}_graph`;
  var script = `
    graph = ConfiguredGraphFactory.open(__graphName);
    g = graph.traversal();
    edge = g.E(__edgeId);
  `;
  var bindings = {
    __graphName,
    __edgeId
  };
  this._execute_gremlin_script(script, bindings, callback);
};

BaseModel.updateEdge = function f(__edgeId, edgeProperties, callback) {
  var properties = this._properties;
  var __graphName = `${properties.keyspace}_graph`;
  var script = `
    graph = ConfiguredGraphFactory.open(__graphName);
    g = graph.traversal();
    edge = g.E(__edgeId);
  `;
  Object.keys(edgeProperties).forEach(function (property) {
    script += `edge.property('${property}', ${property});`;
  });
  script += 'edge';
  var bindings = _.defaults(edgeProperties, {
    __graphName,
    __edgeId
  });
  this._execute_gremlin_script(script, bindings, callback);
};

BaseModel.deleteEdge = function f(__edgeId, callback) {
  var properties = this._properties;
  var __graphName = `${properties.keyspace}_graph`;
  var script = `
    graph = ConfiguredGraphFactory.open(__graphName);
    g = graph.traversal();
    edge = g.E(__edgeId);
    edge.drop();
  `;
  var bindings = {
    __graphName,
    __edgeId
  };
  this._execute_gremlin_script(script, bindings, callback);
};

BaseModel.graphQuery = function f(query, params, callback) {
  var properties = this._properties;
  var __graphName = `${properties.keyspace}_graph`;
  var __vertexLabel = properties.table_name;
  var script = `
    graph = ConfiguredGraphFactory.open(__graphName);
    g = graph.traversal();
    vertices = g.V().hasLabel(__vertexLabel);
  `;
  script += query;
  var bindings = _.defaults(params, {
    __graphName,
    __vertexLabel
  });
  this._execute_gremlin_query(script, bindings, callback);
};

BaseModel.search = function f(queryObject, callback) {
  var esClient = this.get_es_client();
  var indexName = `${this._properties.keyspace}_${this._properties.table_name}`;

  var query = _.defaults(queryObject, {
    index: indexName,
    type: this._properties.table_name
  });
  esClient.search(query, function (err, response) {
    if (err) {
      callback(err);
      return;
    }
    callback(null, response);
  });
};

BaseModel.find = function f(queryObject, options, callback) {
  var _this6 = this;

  if (arguments.length === 2 && typeof options === 'function') {
    callback = options;
    options = {};
  }
  if (typeof callback !== 'function' && !options.return_query) {
    throw buildError('model.find.cberror');
  }

  var defaults = {
    raw: false,
    prepare: true
  };

  options = _.defaultsDeep(options, defaults);

  // set raw true if select is used,
  // because casting to model instances may lead to problems
  if (options.select) options.raw = true;

  var queryParams = [];

  var query = void 0;
  try {
    var findQuery = this.get_find_query(queryObject, options);
    query = findQuery.query;
    queryParams = queryParams.concat(findQuery.params);
  } catch (e) {
    parser.callback_or_throw(e, callback);
    return {};
  }

  if (options.return_query) {
    return { query, params: queryParams };
  }

  var queryOptions = normalizer.normalize_query_option(options);

  this._execute_table_query(query, queryParams, queryOptions, function (err, results) {
    if (err) {
      callback(buildError('model.find.dberror', err));
      return;
    }
    if (!options.raw) {
      var ModelConstructor = _this6._properties.get_constructor();
      results = results.rows.map(function (res) {
        delete res.columns;
        var o = new ModelConstructor(res);
        o._modified = {};
        return o;
      });
      callback(null, results);
    } else {
      results = results.rows.map(function (res) {
        delete res.columns;
        return res;
      });
      callback(null, results);
    }
  });

  return {};
};

BaseModel.findOne = function f(queryObject, options, callback) {
  if (arguments.length === 2 && typeof options === 'function') {
    callback = options;
    options = {};
  }
  if (typeof callback !== 'function' && !options.return_query) {
    throw buildError('model.find.cberror');
  }

  queryObject.$limit = 1;

  return this.find(queryObject, options, function (err, results) {
    if (err) {
      callback(err);
      return;
    }
    if (results.length > 0) {
      callback(null, results[0]);
      return;
    }
    callback();
  });
};

BaseModel.update = function f(queryObject, updateValues, options, callback) {
  if (arguments.length === 3 && typeof options === 'function') {
    callback = options;
    options = {};
  }

  var schema = this._properties.schema;

  var defaults = {
    prepare: true
  };

  options = _.defaultsDeep(options, defaults);

  if (typeof schema.before_update === 'function' && schema.before_update(queryObject, updateValues, options) === false) {
    parser.callback_or_throw(buildError('model.update.before.error'), callback);
    return {};
  }

  var _parser$get_update_va = parser.get_update_value_expression(this, schema, updateValues, callback),
      updateClauses = _parser$get_update_va.updateClauses,
      queryParams = _parser$get_update_va.queryParams,
      errorHappened = _parser$get_update_va.errorHappened;

  if (errorHappened) return {};

  var query = 'UPDATE "%s"';
  var finalParams = queryParams;
  if (_.isNumber(options.ttl)) {
    query += ' USING TTL ?';
    finalParams = [options.ttl].concat(finalParams);
  }
  query += ' SET %s %s';

  var where = '';
  try {
    var whereClause = parser.get_where_clause(schema, queryObject);
    where = whereClause.query;
    finalParams = finalParams.concat(whereClause.params);
  } catch (e) {
    parser.callback_or_throw(e, callback);
    return {};
  }

  query = util.format(query, this._properties.table_name, updateClauses.join(', '), where);

  if (options.conditions) {
    var ifClause = parser.get_if_clause(schema, options.conditions);
    if (ifClause.query) {
      query += util.format(' %s', ifClause.query);
      finalParams = finalParams.concat(ifClause.params);
    }
  } else if (options.if_exists) {
    query += ' IF EXISTS';
  }

  query += ';';

  if (options.return_query) {
    var returnObj = {
      query,
      params: finalParams,
      after_hook: function after_hook() {
        if (typeof schema.after_update === 'function' && schema.after_update(queryObject, updateValues, options) === false) {
          return buildError('model.update.after.error');
        }
        return true;
      }
    };
    return returnObj;
  }

  var queryOptions = normalizer.normalize_query_option(options);

  this._execute_table_query(query, finalParams, queryOptions, function (err, results) {
    if (typeof callback === 'function') {
      if (err) {
        callback(buildError('model.update.dberror', err));
        return;
      }
      if (typeof schema.after_update === 'function' && schema.after_update(queryObject, updateValues, options) === false) {
        callback(buildError('model.update.after.error'));
        return;
      }
      callback(null, results);
    } else if (err) {
      throw buildError('model.update.dberror', err);
    } else if (typeof schema.after_update === 'function' && schema.after_update(queryObject, updateValues, options) === false) {
      throw buildError('model.update.after.error');
    }
  });

  return {};
};

BaseModel.delete = function f(queryObject, options, callback) {
  if (arguments.length === 2 && typeof options === 'function') {
    callback = options;
    options = {};
  }

  var schema = this._properties.schema;

  var defaults = {
    prepare: true
  };

  options = _.defaultsDeep(options, defaults);

  if (typeof schema.before_delete === 'function' && schema.before_delete(queryObject, options) === false) {
    parser.callback_or_throw(buildError('model.delete.before.error'), callback);
    return {};
  }

  var queryParams = [];

  var query = 'DELETE FROM "%s" %s;';
  var where = '';
  try {
    var whereClause = parser.get_where_clause(schema, queryObject);
    where = whereClause.query;
    queryParams = queryParams.concat(whereClause.params);
  } catch (e) {
    parser.callback_or_throw(e, callback);
    return {};
  }

  query = util.format(query, this._properties.table_name, where);

  if (options.return_query) {
    var returnObj = {
      query,
      params: queryParams,
      after_hook: function after_hook() {
        if (typeof schema.after_delete === 'function' && schema.after_delete(queryObject, options) === false) {
          return buildError('model.delete.after.error');
        }
        return true;
      }
    };
    return returnObj;
  }

  var queryOptions = normalizer.normalize_query_option(options);

  this._execute_table_query(query, queryParams, queryOptions, function (err, results) {
    if (typeof callback === 'function') {
      if (err) {
        callback(buildError('model.delete.dberror', err));
        return;
      }
      if (typeof schema.after_delete === 'function' && schema.after_delete(queryObject, options) === false) {
        callback(buildError('model.delete.after.error'));
        return;
      }
      callback(null, results);
    } else if (err) {
      throw buildError('model.delete.dberror', err);
    } else if (typeof schema.after_delete === 'function' && schema.after_delete(queryObject, options) === false) {
      throw buildError('model.delete.after.error');
    }
  });

  return {};
};

BaseModel.truncate = function f(callback) {
  var properties = this._properties;
  var tableName = properties.table_name;

  var query = util.format('TRUNCATE TABLE "%s";', tableName);
  this._execute_table_query(query, [], callback);
};

BaseModel.prototype.get_data_types = function f() {
  return cql.types;
};

BaseModel.prototype.get_table_name = function f() {
  return this.constructor.get_table_name();
};

BaseModel.prototype.get_keyspace_name = function f() {
  return this.constructor.get_keyspace_name();
};

BaseModel.prototype._get_default_value = function f(fieldname) {
  var properties = this.constructor._properties;
  var schema = properties.schema;

  if (_.isPlainObject(schema.fields[fieldname]) && schema.fields[fieldname].default !== undefined) {
    if (typeof schema.fields[fieldname].default === 'function') {
      return schema.fields[fieldname].default.call(this);
    }
    return schema.fields[fieldname].default;
  }
  return undefined;
};

BaseModel.prototype.validate = function f(propertyName, value) {
  value = value || this[propertyName];
  this._validators = this._validators || {};
  return schemer.get_validation_message(this._validators[propertyName] || [], value);
};

BaseModel.prototype.save = function fn(options, callback) {
  var _this7 = this;

  if (arguments.length === 1 && typeof options === 'function') {
    callback = options;
    options = {};
  }

  var properties = this.constructor._properties;
  var schema = properties.schema;

  var defaults = {
    prepare: true
  };

  options = _.defaultsDeep(options, defaults);

  if (typeof schema.before_save === 'function' && schema.before_save(this, options) === false) {
    parser.callback_or_throw(buildError('model.save.before.error'), callback);
    return {};
  }

  var _parser$get_save_valu = parser.get_save_value_expression(this, schema, callback),
      identifiers = _parser$get_save_valu.identifiers,
      values = _parser$get_save_valu.values,
      queryParams = _parser$get_save_valu.queryParams,
      errorHappened = _parser$get_save_valu.errorHappened;

  if (errorHappened) return {};

  var query = util.format('INSERT INTO "%s" ( %s ) VALUES ( %s )', properties.table_name, identifiers.join(' , '), values.join(' , '));

  if (options.if_not_exist) query += ' IF NOT EXISTS';

  var finalParams = queryParams;
  if (_.isNumber(options.ttl)) {
    query += ' USING TTL ?';
    finalParams = finalParams.concat([options.ttl]);
  }

  query += ';';

  if (options.return_query) {
    var returnObj = {
      query,
      params: finalParams,
      after_hook: function after_hook() {
        if (typeof schema.after_save === 'function' && schema.after_save(_this7, options) === false) {
          return buildError('model.save.after.error');
        }
        return true;
      }
    };
    return returnObj;
  }

  var queryOptions = normalizer.normalize_query_option(options);

  this.constructor._execute_table_query(query, finalParams, queryOptions, function (err, result) {
    if (typeof callback === 'function') {
      if (err) {
        callback(buildError('model.save.dberror', err));
        return;
      }
      if (!options.if_not_exist || result.rows && result.rows[0] && result.rows[0]['[applied]']) {
        _this7._modified = {};
      }
      if (typeof schema.after_save === 'function' && schema.after_save(_this7, options) === false) {
        callback(buildError('model.save.after.error'));
        return;
      }
      callback(null, result);
    } else if (err) {
      throw buildError('model.save.dberror', err);
    } else if (typeof schema.after_save === 'function' && schema.after_save(_this7, options) === false) {
      throw buildError('model.save.after.error');
    }
  });

  return {};
};

BaseModel.prototype.delete = function f(options, callback) {
  if (arguments.length === 1 && typeof options === 'function') {
    callback = options;
    options = {};
  }

  var schema = this.constructor._properties.schema;
  var deleteQuery = {};

  for (var i = 0; i < schema.key.length; i++) {
    var fieldKey = schema.key[i];
    if (_.isArray(fieldKey)) {
      for (var j = 0; j < fieldKey.length; j++) {
        deleteQuery[fieldKey[j]] = this[fieldKey[j]];
      }
    } else {
      deleteQuery[fieldKey] = this[fieldKey];
    }
  }

  return this.constructor.delete(deleteQuery, options, callback);
};

BaseModel.prototype.toJSON = function toJSON() {
  var _this8 = this;

  var object = {};
  var schema = this.constructor._properties.schema;

  Object.keys(schema.fields).forEach(function (field) {
    object[field] = _this8[field];
  });

  return object;
};

BaseModel.prototype.isModified = function isModified(propName) {
  if (propName) {
    return Object.prototype.hasOwnProperty.call(this._modified, propName);
  }
  return Object.keys(this._modified).length !== 0;
};

module.exports = BaseModel;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9vcm0vYmFzZV9tb2RlbC5qcyJdLCJuYW1lcyI6WyJQcm9taXNlIiwicmVxdWlyZSIsIl8iLCJ1dGlsIiwiZHNlRHJpdmVyIiwiZSIsImNxbCIsInByb21pc2lmeUFsbCIsImJ1aWxkRXJyb3IiLCJzY2hlbWVyIiwibm9ybWFsaXplciIsInBhcnNlciIsIlRhYmxlQnVpbGRlciIsIkVsYXNzYW5kcmFCdWlsZGVyIiwiSmFudXNHcmFwaEJ1aWxkZXIiLCJEcml2ZXIiLCJCYXNlTW9kZWwiLCJmIiwiaW5zdGFuY2VWYWx1ZXMiLCJmaWVsZFZhbHVlcyIsImZpZWxkcyIsImNvbnN0cnVjdG9yIiwiX3Byb3BlcnRpZXMiLCJzY2hlbWEiLCJtZXRob2RzIiwibW9kZWwiLCJkZWZhdWx0U2V0dGVyIiwiZjEiLCJwcm9wTmFtZSIsIm5ld1ZhbHVlIiwiX21vZGlmaWVkIiwiZGVmYXVsdEdldHRlciIsIl92YWxpZGF0b3JzIiwiZmllbGRzS2V5cyIsIk9iamVjdCIsImtleXMiLCJpIiwibGVuIiwibGVuZ3RoIiwicHJvcGVydHlOYW1lIiwiZmllbGQiLCJnZXRfdmFsaWRhdG9ycyIsIm1lc3NhZ2UiLCJzZXR0ZXIiLCJiaW5kIiwiZ2V0dGVyIiwidmlydHVhbCIsInNldCIsImdldCIsImRlc2NyaXB0b3IiLCJlbnVtZXJhYmxlIiwiZGVmaW5lUHJvcGVydHkiLCJtZXRob2ROYW1lcyIsIm1ldGhvZE5hbWUiLCJtZXRob2QiLCJuYW1lIiwiX3NldF9wcm9wZXJ0aWVzIiwicHJvcGVydGllcyIsInRhYmxlTmFtZSIsInRhYmxlX25hbWUiLCJ2YWxpZGF0ZV90YWJsZV9uYW1lIiwicXVhbGlmaWVkVGFibGVOYW1lIiwiZm9ybWF0Iiwia2V5c3BhY2UiLCJxdWFsaWZpZWRfdGFibGVfbmFtZSIsIl9kcml2ZXIiLCJfc3luY19tb2RlbF9kZWZpbml0aW9uIiwiY2FsbGJhY2siLCJtb2RlbFNjaGVtYSIsIm1pZ3JhdGlvbiIsInRhYmxlQnVpbGRlciIsImRyb3BUYWJsZU9uU2NoZW1hQ2hhbmdlIiwicHJvY2VzcyIsImVudiIsIk5PREVfRU5WIiwiZ2V0X3RhYmxlX3NjaGVtYSIsImVyciIsImRiU2NoZW1hIiwiYWZ0ZXJEQkNyZWF0ZSIsImVycjEiLCJpbmRleGluZ1Rhc2tzIiwiaXNBcnJheSIsImluZGV4ZXMiLCJjcmVhdGVJbmRleGVzQXN5bmMiLCJwcm9taXNpZnkiLCJjcmVhdGVfaW5kZXhlcyIsInB1c2giLCJjdXN0b21faW5kZXhlcyIsImNyZWF0ZUN1c3RvbUluZGV4ZXNBc3luYyIsImNyZWF0ZV9jdXN0b21faW5kZXhlcyIsImN1c3RvbV9pbmRleCIsImNyZWF0ZUN1c3RvbUluZGV4QXN5bmMiLCJtYXRlcmlhbGl6ZWRfdmlld3MiLCJjcmVhdGVWaWV3c0FzeW5jIiwiY3JlYXRlX212aWV3cyIsImFsbCIsInRoZW4iLCJjYXRjaCIsImVycjIiLCJjcmVhdGVUYWJsZSIsImNyZWF0ZV90YWJsZSIsIm5vcm1hbGl6ZWRNb2RlbFNjaGVtYSIsIm5vcm1hbGl6ZWREQlNjaGVtYSIsIm5vcm1hbGl6ZV9tb2RlbF9zY2hlbWEiLCJpc0VxdWFsIiwia2V5IiwiY2x1c3RlcmluZ19vcmRlciIsImluaXRfYWx0ZXJfb3BlcmF0aW9ucyIsImRyb3BfcmVjcmVhdGVfdGFibGUiLCJfc3luY19lc19pbmRleCIsImVzY2xpZW50IiwiZXNfaW5kZXhfbWFwcGluZyIsImtleXNwYWNlTmFtZSIsIm1hcHBpbmdOYW1lIiwiaW5kZXhOYW1lIiwiZWxhc3NhbmRyYUJ1aWxkZXIiLCJhc3NlcnRfaW5kZXgiLCJwdXRfbWFwcGluZyIsIl9zeW5jX2dyYXBoIiwiZ3JlbWxpbl9jbGllbnQiLCJncmFwaF9tYXBwaW5nIiwiZ3JhcGhOYW1lIiwiZ3JhcGhCdWlsZGVyIiwiYXNzZXJ0X2dyYXBoIiwiX2V4ZWN1dGVfdGFibGVfcXVlcnkiLCJxdWVyeSIsInBhcmFtcyIsIm9wdGlvbnMiLCJhcmd1bWVudHMiLCJkZWZhdWx0cyIsInByZXBhcmUiLCJkZWZhdWx0c0RlZXAiLCJkb0V4ZWN1dGVRdWVyeSIsImRvcXVlcnkiLCJkb2NhbGxiYWNrIiwiZXhlY3V0ZV9xdWVyeSIsImlzX3RhYmxlX3JlYWR5IiwiaW5pdCIsImdldF9maW5kX3F1ZXJ5IiwicXVlcnlPYmplY3QiLCJvcmRlcmJ5Q2xhdXNlIiwiZ2V0X29yZGVyYnlfY2xhdXNlIiwibGltaXRDbGF1c2UiLCJnZXRfbGltaXRfY2xhdXNlIiwid2hlcmVDbGF1c2UiLCJnZXRfd2hlcmVfY2xhdXNlIiwic2VsZWN0Q2xhdXNlIiwiZ2V0X3NlbGVjdF9jbGF1c2UiLCJncm91cGJ5Q2xhdXNlIiwiZ2V0X2dyb3VwYnlfY2xhdXNlIiwiZGlzdGluY3QiLCJtYXRlcmlhbGl6ZWRfdmlldyIsImFsbG93X2ZpbHRlcmluZyIsImdldF90YWJsZV9uYW1lIiwiZ2V0X2tleXNwYWNlX25hbWUiLCJfcmVhZHkiLCJ1bmRlZmluZWQiLCJzeW5jREIiLCJyZXN1bHQiLCJnZXRfY3FsX2NsaWVudCIsImVuc3VyZV9pbml0IiwiZ2V0X2VzX2NsaWVudCIsIkVycm9yIiwiZ2V0X2dyZW1saW5fY2xpZW50IiwiZXhlY3V0ZV9iYXRjaCIsImV4ZWN1dGVfZWFjaFJvdyIsIl9leGVjdXRlX3RhYmxlX2VhY2hSb3ciLCJvblJlYWRhYmxlIiwiZWFjaFJvdyIsImNiIiwicmF3IiwicmV0dXJuX3F1ZXJ5Iiwic2VsZWN0UXVlcnkiLCJmaW5kIiwicXVlcnlPcHRpb25zIiwibm9ybWFsaXplX3F1ZXJ5X29wdGlvbiIsIm4iLCJyb3ciLCJNb2RlbENvbnN0cnVjdG9yIiwiZ2V0X2NvbnN0cnVjdG9yIiwiZXhlY3V0ZV9zdHJlYW0iLCJfZXhlY3V0ZV90YWJsZV9zdHJlYW0iLCJzdHJlYW0iLCJzZWxmIiwicmVhZGVyIiwicmVhZFJvdyIsInJlYWQiLCJvIiwiX2V4ZWN1dGVfZ3JlbWxpbl9xdWVyeSIsInNjcmlwdCIsImJpbmRpbmdzIiwiZ3JlbWxpbkNsaWVudCIsImV4ZWN1dGUiLCJyZXN1bHRzIiwiX2V4ZWN1dGVfZ3JlbWxpbl9zY3JpcHQiLCJjcmVhdGVWZXJ0ZXgiLCJ2ZXJ0ZXhQcm9wZXJ0aWVzIiwiX19ncmFwaE5hbWUiLCJfX3ZlcnRleExhYmVsIiwiZm9yRWFjaCIsInByb3BlcnR5IiwiZ2V0VmVydGV4IiwiX192ZXJ0ZXhJZCIsInVwZGF0ZVZlcnRleCIsImRlbGV0ZVZlcnRleCIsImNyZWF0ZUVkZ2UiLCJfX2VkZ2VMYWJlbCIsIl9fZnJvbVZlcnRleElkIiwiX190b1ZlcnRleElkIiwiZWRnZVByb3BlcnRpZXMiLCJnZXRFZGdlIiwiX19lZGdlSWQiLCJ1cGRhdGVFZGdlIiwiZGVsZXRlRWRnZSIsImdyYXBoUXVlcnkiLCJzZWFyY2giLCJlc0NsaWVudCIsImluZGV4IiwidHlwZSIsInJlc3BvbnNlIiwic2VsZWN0IiwicXVlcnlQYXJhbXMiLCJmaW5kUXVlcnkiLCJjb25jYXQiLCJjYWxsYmFja19vcl90aHJvdyIsInJvd3MiLCJtYXAiLCJyZXMiLCJjb2x1bW5zIiwiZmluZE9uZSIsIiRsaW1pdCIsInVwZGF0ZSIsInVwZGF0ZVZhbHVlcyIsImJlZm9yZV91cGRhdGUiLCJnZXRfdXBkYXRlX3ZhbHVlX2V4cHJlc3Npb24iLCJ1cGRhdGVDbGF1c2VzIiwiZXJyb3JIYXBwZW5lZCIsImZpbmFsUGFyYW1zIiwiaXNOdW1iZXIiLCJ0dGwiLCJ3aGVyZSIsImpvaW4iLCJjb25kaXRpb25zIiwiaWZDbGF1c2UiLCJnZXRfaWZfY2xhdXNlIiwiaWZfZXhpc3RzIiwicmV0dXJuT2JqIiwiYWZ0ZXJfaG9vayIsImFmdGVyX3VwZGF0ZSIsImRlbGV0ZSIsImJlZm9yZV9kZWxldGUiLCJhZnRlcl9kZWxldGUiLCJ0cnVuY2F0ZSIsInByb3RvdHlwZSIsImdldF9kYXRhX3R5cGVzIiwidHlwZXMiLCJfZ2V0X2RlZmF1bHRfdmFsdWUiLCJmaWVsZG5hbWUiLCJpc1BsYWluT2JqZWN0IiwiZGVmYXVsdCIsImNhbGwiLCJ2YWxpZGF0ZSIsInZhbHVlIiwiZ2V0X3ZhbGlkYXRpb25fbWVzc2FnZSIsInNhdmUiLCJmbiIsImJlZm9yZV9zYXZlIiwiZ2V0X3NhdmVfdmFsdWVfZXhwcmVzc2lvbiIsImlkZW50aWZpZXJzIiwidmFsdWVzIiwiaWZfbm90X2V4aXN0IiwiYWZ0ZXJfc2F2ZSIsImRlbGV0ZVF1ZXJ5IiwiZmllbGRLZXkiLCJqIiwidG9KU09OIiwib2JqZWN0IiwiaXNNb2RpZmllZCIsImhhc093blByb3BlcnR5IiwibW9kdWxlIiwiZXhwb3J0cyJdLCJtYXBwaW5ncyI6Ijs7QUFBQSxJQUFNQSxVQUFVQyxRQUFRLFVBQVIsQ0FBaEI7QUFDQSxJQUFNQyxJQUFJRCxRQUFRLFFBQVIsQ0FBVjtBQUNBLElBQU1FLE9BQU9GLFFBQVEsTUFBUixDQUFiOztBQUVBLElBQUlHLGtCQUFKO0FBQ0EsSUFBSTtBQUNGO0FBQ0FBLGNBQVlILFFBQVEsWUFBUixDQUFaO0FBQ0QsQ0FIRCxDQUdFLE9BQU9JLENBQVAsRUFBVTtBQUNWRCxjQUFZLElBQVo7QUFDRDs7QUFFRCxJQUFNRSxNQUFNTixRQUFRTyxZQUFSLENBQXFCSCxhQUFhSCxRQUFRLGtCQUFSLENBQWxDLENBQVo7O0FBRUEsSUFBTU8sYUFBYVAsUUFBUSxtQkFBUixDQUFuQjtBQUNBLElBQU1RLFVBQVVSLFFBQVEsc0JBQVIsQ0FBaEI7QUFDQSxJQUFNUyxhQUFhVCxRQUFRLHFCQUFSLENBQW5CO0FBQ0EsSUFBTVUsU0FBU1YsUUFBUSxpQkFBUixDQUFmOztBQUVBLElBQU1XLGVBQWVYLFFBQVEsbUJBQVIsQ0FBckI7QUFDQSxJQUFNWSxvQkFBb0JaLFFBQVEsd0JBQVIsQ0FBMUI7QUFDQSxJQUFNYSxvQkFBb0JiLFFBQVEsd0JBQVIsQ0FBMUI7QUFDQSxJQUFNYyxTQUFTZCxRQUFRLG1CQUFSLENBQWY7O0FBRUEsSUFBTWUsWUFBWSxTQUFTQyxDQUFULENBQVdDLGNBQVgsRUFBMkI7QUFDM0NBLG1CQUFpQkEsa0JBQWtCLEVBQW5DO0FBQ0EsTUFBTUMsY0FBYyxFQUFwQjtBQUNBLE1BQU1DLFNBQVMsS0FBS0MsV0FBTCxDQUFpQkMsV0FBakIsQ0FBNkJDLE1BQTdCLENBQW9DSCxNQUFuRDtBQUNBLE1B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QWlCeUIsY0FBakIsQ0FBZ0NsQixJQUFoQyxDQUFxQyxLQUFLdE8sU0FBMUMsRUFBcURGLFFBQXJELENBQVA7QUFDRDtBQUNELFNBQU9NLE9BQU9DLElBQVAsQ0FBWSxLQUFLTCxTQUFqQixFQUE0QlEsTUFBNUIsS0FBdUMsQ0FBOUM7QUFDRCxDQUxEOztBQU9BaVAsT0FBT0MsT0FBUCxHQUFpQnhRLFNBQWpCIiwiZmlsZSI6ImJhc2VfbW9kZWwuanMiLCJzb3VyY2VzQ29udGVudCI6WyJjb25zdCBQcm9taXNlID0gcmVxdWlyZSgnYmx1ZWJpcmQnKTtcbmNvbnN0IF8gPSByZXF1aXJlKCdsb2Rhc2gnKTtcbmNvbnN0IHV0aWwgPSByZXF1aXJlKCd1dGlsJyk7XG5cbmxldCBkc2VEcml2ZXI7XG50cnkge1xuICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgaW1wb3J0L25vLWV4dHJhbmVvdXMtZGVwZW5kZW5jaWVzLCBpbXBvcnQvbm8tdW5yZXNvbHZlZFxuICBkc2VEcml2ZXIgPSByZXF1aXJlKCdkc2UtZHJpdmVyJyk7XG59IGNhdGNoIChlKSB7XG4gIGRzZURyaXZlciA9IG51bGw7XG59XG5cbmNvbnN0IGNxbCA9IFByb21pc2UucHJvbWlzaWZ5QWxsKGRzZURyaXZlciB8fCByZXF1aXJlKCdjYXNzYW5kcmEtZHJpdmVyJykpO1xuXG5jb25zdCBidWlsZEVycm9yID0gcmVxdWlyZSgnLi9hcG9sbG9fZXJyb3IuanMnKTtcbmNvbnN0IHNjaGVtZXIgPSByZXF1aXJlKCcuLi92YWxpZGF0b3JzL3NjaGVtYScpO1xuY29uc3Qgbm9ybWFsaXplciA9IHJlcXVpcmUoJy4uL3V0aWxzL25vcm1hbGl6ZXInKTtcbmNvbnN0IHBhcnNlciA9IHJlcXVpcmUoJy4uL3V0aWxzL3BhcnNlcicpO1xuXG5jb25zdCBUYWJsZUJ1aWxkZXIgPSByZXF1aXJlKCcuLi9idWlsZGVycy90YWJsZScpO1xuY29uc3QgRWxhc3NhbmRyYUJ1aWxkZXIgPSByZXF1aXJlKCcuLi9idWlsZGVycy9lbGFzc2FuZHJhJyk7XG5jb25zdCBKYW51c0dyYXBoQnVpbGRlciA9IHJlcXVpcmUoJy4uL2J1aWxkZXJzL2phbnVzZ3JhcGgnKTtcbmNvbnN0IERyaXZlciA9IHJlcXVpcmUoJy4uL2hlbHBlcnMvZHJpdmVyJyk7XG5cbmNvbnN0IEJhc2VNb2RlbCA9IGZ1bmN0aW9uIGYoaW5zdGFuY2VWYWx1ZXMpIHtcbiAgaW5zdGFuY2VWYWx1ZXMgPSBpbnN0YW5jZVZhbHVlcyB8fCB7fTtcbiAgY29uc3QgZmllbGRWYWx1ZXMgPSB7fTtcbiAgY29uc3QgZmllbGRzID0gdGhpcy5jb25zdHJ1Y3Rvci5fcHJvcGVydGllcy5zY2hlbWEuZmllbGRzO1xuICBjb25zdCBtZXRob2RzID0gdGhpcy5jb25zdHJ1Y3Rvci5fcHJvcGVydGllcy5zY2hlbWEubWV0aG9kcyB8fCB7fTtcbiAgY29uc3QgbW9kZWwgPSB0aGlzO1xuXG4gIGNvbnN0IGRlZmF1bHRTZXR0ZXIgPSBmdW5jdGlvbiBmMShwcm9wTmFtZSwgbmV3VmFsdWUpIHtcbiAgICBpZiAodGhpc1twcm9wTmFtZV0gIT09IG5ld1ZhbHVlKSB7XG4gICAgICBtb2RlbC5fbW9kaWZpZWRbcHJvcE5hbWVdID0gdHJ1ZTtcbiAgICB9XG4gICAgdGhpc1twcm9wTmFtZV0gPSBuZXdWYWx1ZTtcbiAgfTtcblxuICBjb25zdCBkZWZhdWx0R2V0dGVyID0gZnVuY3Rpb24gZjEocHJvcE5hbWUpIHtcbiAgICByZXR1cm4gdGhpc1twcm9wTmFtZV07XG4gIH07XG5cbiAgdGhpcy5fbW9kaWZpZWQgPSB7fTtcbiAgdGhpcy5fdmFsaWRhdG9ycyA9IHt9O1xuXG4gIGZvciAobGV0IGZpZWxkc0tleXMgPSBPYmplY3Qua2V5cyhmaWVsZHMpLCBpID0gMCwgbGVuID0gZmllbGRzS2V5cy5sZW5ndGg7IGkgPCBsZW47IGkrKykge1xuICAgIGNvbnN0IHByb3BlcnR5TmFtZSA9IGZpZWxkc0tleXNbaV07XG4gICAgY29uc3QgZmllbGQgPSBmaWVsZHNbZmllbGRzS2V5c1tpXV07XG5cbiAgICB0cnkge1xuICAgICAgdGhpcy5fdmFsaWRhdG9yc1twcm9wZXJ0eU5hbWVdID0gc2NoZW1lci5nZXRfdmFsaWRhdG9ycyh0aGlzLmNvbnN0cnVjdG9yLl9wcm9wZXJ0aWVzLnNjaGVtYSwgcHJvcGVydHlOYW1lKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwudmFsaWRhdG9yLmludmFsaWRzY2hlbWEnLCBlLm1lc3NhZ2UpKTtcbiAgICB9XG5cbiAgICBsZXQgc2V0dGVyID0gZGVmYXVsdFNldHRlci5iaW5kKGZpZWxkVmFsdWVzLCBwcm9wZXJ0eU5hbWUpO1xuICAgIGxldCBnZXR0ZXIgPSBkZWZhdWx0R2V0dGVyLmJpbmQoZmllbGRWYWx1ZXMsIHByb3BlcnR5TmFtZSk7XG5cbiAgICBpZiAoZmllbGQudmlydHVhbCAmJiB0eXBlb2YgZmllbGQudmlydHVhbC5zZXQgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgIHNldHRlciA9IGZpZWxkLnZpcnR1YWwuc2V0LmJpbmQoZmllbGRWYWx1ZXMpO1xuICAgIH1cblxuICAgIGlmIChmaWVsZC52aXJ0dWFsICYmIHR5cGVvZiBmaWVsZC52aXJ0dWFsLmdldCA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgZ2V0dGVyID0gZmllbGQudmlydHVhbC5nZXQuYmluZChmaWVsZFZhbHVlcyk7XG4gICAgfVxuXG4gICAgY29uc3QgZGVzY3JpcHRvciA9IHtcbiAgICAgIGVudW1lcmFibGU6IHRydWUsXG4gICAgICBzZXQ6IHNldHRlcixcbiAgICAgIGdldDogZ2V0dGVyLFxuICAgIH07XG5cbiAgICBPYmplY3QuZGVmaW5lUHJvcGVydHkodGhpcywgcHJvcGVydHlOYW1lLCBkZXNjcmlwdG9yKTtcbiAgICBpZiAoZmllbGQudmlydHVhbCAmJiB0eXBlb2YgaW5zdGFuY2VWYWx1ZXNbcHJvcGVydHlOYW1lXSAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgIHRoaXNbcHJvcGVydHlOYW1lXSA9IGluc3RhbmNlVmFsdWVzW3Byb3BlcnR5TmFtZV07XG4gICAgfVxuICB9XG5cbiAgZm9yIChsZXQgZmllbGRzS2V5cyA9IE9iamVjdC5rZXlzKGZpZWxkcyksIGkgPSAwLCBsZW4gPSBmaWVsZHNLZXlzLmxlbmd0aDsgaSA8IGxlbjsgaSsrKSB7XG4gICAgY29uc3QgcHJvcGVydHlOYW1lID0gZmllbGRzS2V5c1tpXTtcbiAgICBjb25zdCBmaWVsZCA9IGZpZWxkc1tmaWVsZHNLZXlzW2ldXTtcblxuICAgIGlmICghZmllbGQudmlydHVhbCAmJiB0eXBlb2YgaW5zdGFuY2VWYWx1ZXNbcHJvcGVydHlOYW1lXSAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgICAgIHRoaXNbcHJvcGVydHlOYW1lXSA9IGluc3RhbmNlVmFsdWVzW3Byb3BlcnR5TmFtZV07XG4gICAgfVxuICB9XG5cbiAgZm9yIChsZXQgbWV0aG9kTmFtZXMgPSBPYmplY3Qua2V5cyhtZXRob2RzKSwgaSA9IDAsIGxlbiA9IG1ldGhvZE5hbWVzLmxlbmd0aDsgaSA8IGxlbjsgaSsrKSB7XG4gICAgY29uc3QgbWV0aG9kTmFtZSA9IG1ldGhvZE5hbWVzW2ldO1xuICAgIGNvbnN0IG1ldGhvZCA9IG1ldGhvZHNbbWV0aG9kTmFtZV07XG4gICAgdGhpc1ttZXRob2ROYW1lXSA9IG1ldGhvZDtcbiAgfVxufTtcblxuQmFzZU1vZGVsLl9wcm9wZXJ0aWVzID0ge1xuICBuYW1lOiBudWxsLFxuICBzY2hlbWE6IG51bGwsXG59O1xuXG5CYXNlTW9kZWwuX3NldF9wcm9wZXJ0aWVzID0gZnVuY3Rpb24gZihwcm9wZXJ0aWVzKSB7XG4gIGNvbnN0IHNjaGVtYSA9IHByb3BlcnRpZXMuc2NoZW1hO1xuICBjb25zdCB0YWJsZU5hbWUgPSBzY2hlbWEudGFibGVfbmFtZSB8fCBwcm9wZXJ0aWVzLm5hbWU7XG5cbiAgaWYgKCFzY2hlbWVyLnZhbGlkYXRlX3RhYmxlX25hbWUodGFibGVOYW1lKSkge1xuICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC50YWJsZWNyZWF0aW9uLmludmFsaWRuYW1lJywgdGFibGVOYW1lKSk7XG4gIH1cblxuICBjb25zdCBxdWFsaWZpZWRUYWJsZU5hbWUgPSB1dGlsLmZvcm1hdCgnXCIlc1wiLlwiJXNcIicsIHByb3BlcnRpZXMua2V5c3BhY2UsIHRhYmxlTmFtZSk7XG5cbiAgdGhpcy5fcHJvcGVydGllcyA9IHByb3BlcnRpZXM7XG4gIHRoaXMuX3Byb3BlcnRpZXMudGFibGVfbmFtZSA9IHRhYmxlTmFtZTtcbiAgdGhpcy5fcHJvcGVydGllcy5xdWFsaWZpZWRfdGFibGVfbmFtZSA9IHF1YWxpZmllZFRhYmxlTmFtZTtcbiAgdGhpcy5fZHJpdmVyID0gbmV3IERyaXZlcih0aGlzLl9wcm9wZXJ0aWVzKTtcbn07XG5cbkJhc2VNb2RlbC5fc3luY19tb2RlbF9kZWZpbml0aW9uID0gZnVuY3Rpb24gZihjYWxsYmFjaykge1xuICBjb25zdCBwcm9wZXJ0aWVzID0gdGhpcy5fcHJvcGVydGllcztcbiAgY29uc3QgdGFibGVOYW1lID0gcHJvcGVydGllcy50YWJsZV9uYW1lO1xuICBjb25zdCBtb2RlbFNjaGVtYSA9IHByb3BlcnRpZXMuc2NoZW1hO1xuICBsZXQgbWlncmF0aW9uID0gcHJvcGVydGllcy5taWdyYXRpb247XG5cbiAgY29uc3QgdGFibGVCdWlsZGVyID0gbmV3IFRhYmxlQnVpbGRlcih0aGlzLl9kcml2ZXIsIHRoaXMuX3Byb3BlcnRpZXMpO1xuXG4gIC8vIGJhY2t3YXJkcyBjb21wYXRpYmxlIGNoYW5nZSwgZHJvcFRhYmxlT25TY2hlbWFDaGFuZ2Ugd2lsbCB3b3JrIGxpa2UgbWlncmF0aW9uOiAnZHJvcCdcbiAgaWYgKCFtaWdyYXRpb24pIHtcbiAgICBpZiAocHJvcGVydGllcy5kcm9wVGFibGVPblNjaGVtYUNoYW5nZSkgbWlncmF0aW9uID0gJ2Ryb3AnO1xuICAgIGVsc2UgbWlncmF0aW9uID0gJ3NhZmUnO1xuICB9XG4gIC8vIGFsd2F5cyBzYWZlIG1pZ3JhdGUgaWYgTk9ERV9FTlY9PT0ncHJvZHVjdGlvbidcbiAgaWYgKHByb2Nlc3MuZW52Lk5PREVfRU5WID09PSAncHJvZHVjdGlvbicpIG1pZ3JhdGlvbiA9ICdzYWZlJztcblxuICAvLyBjaGVjayBmb3IgZXhpc3RlbmNlIG9mIHRhYmxlIG9uIERCIGFuZCBpZiBpdCBtYXRjaGVzIHRoaXMgbW9kZWwncyBzY2hlbWFcbiAgdGFibGVCdWlsZGVyLmdldF90YWJsZV9zY2hlbWEoKGVyciwgZGJTY2hlbWEpID0+IHtcbiAgICBpZiAoZXJyKSB7XG4gICAgICBjYWxsYmFjayhlcnIpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IGFmdGVyREJDcmVhdGUgPSAoZXJyMSkgPT4ge1xuICAgICAgaWYgKGVycjEpIHtcbiAgICAgICAgY2FsbGJhY2soZXJyMSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgY29uc3QgaW5kZXhpbmdUYXNrcyA9IFtdO1xuXG4gICAgICAvLyBjYXNzYW5kcmEgaW5kZXggY3JlYXRlIGlmIGRlZmluZWRcbiAgICAgIGlmIChfLmlzQXJyYXkobW9kZWxTY2hlbWEuaW5kZXhlcykpIHtcbiAgICAgICAgdGFibGVCdWlsZGVyLmNyZWF0ZUluZGV4ZXNBc3luYyA9IFByb21pc2UucHJvbWlzaWZ5KHRhYmxlQnVpbGRlci5jcmVhdGVfaW5kZXhlcyk7XG4gICAgICAgIGluZGV4aW5nVGFza3MucHVzaCh0YWJsZUJ1aWxkZXIuY3JlYXRlSW5kZXhlc0FzeW5jKG1vZGVsU2NoZW1hLmluZGV4ZXMpKTtcbiAgICAgIH1cbiAgICAgIC8vIGNhc3NhbmRyYSBjdXN0b20gaW5kZXggY3JlYXRlIGlmIGRlZmluZWRcbiAgICAgIGlmIChfLmlzQXJyYXkobW9kZWxTY2hlbWEuY3VzdG9tX2luZGV4ZXMpKSB7XG4gICAgICAgIHRhYmxlQnVpbGRlci5jcmVhdGVDdXN0b21JbmRleGVzQXN5bmMgPSBQcm9taXNlLnByb21pc2lmeSh0YWJsZUJ1aWxkZXIuY3JlYXRlX2N1c3RvbV9pbmRleGVzKTtcbiAgICAgICAgaW5kZXhpbmdUYXNrcy5wdXNoKHRhYmxlQnVpbGRlci5jcmVhdGVDdXN0b21JbmRleGVzQXN5bmMobW9kZWxTY2hlbWEuY3VzdG9tX2luZGV4ZXMpKTtcbiAgICAgIH1cbiAgICAgIGlmIChtb2RlbFNjaGVtYS5jdXN0b21faW5kZXgpIHtcbiAgICAgICAgdGFibGVCdWlsZGVyLmNyZWF0ZUN1c3RvbUluZGV4QXN5bmMgPSBQcm9taXNlLnByb21pc2lmeSh0YWJsZUJ1aWxkZXIuY3JlYXRlX2N1c3RvbV9pbmRleGVzKTtcbiAgICAgICAgaW5kZXhpbmdUYXNrcy5wdXNoKHRhYmxlQnVpbGRlci5jcmVhdGVDdXN0b21JbmRleEFzeW5jKFttb2RlbFNjaGVtYS5jdXN0b21faW5kZXhdKSk7XG4gICAgICB9XG4gICAgICAvLyBtYXRlcmlhbGl6ZWQgdmlldyBjcmVhdGUgaWYgZGVmaW5lZFxuICAgICAgaWYgKG1vZGVsU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3cykge1xuICAgICAgICB0YWJsZUJ1aWxkZXIuY3JlYXRlVmlld3NBc3luYyA9IFByb21pc2UucHJvbWlzaWZ5KHRhYmxlQnVpbGRlci5jcmVhdGVfbXZpZXdzKTtcbiAgICAgICAgaW5kZXhpbmdUYXNrcy5wdXNoKHRhYmxlQnVpbGRlci5jcmVhdGVWaWV3c0FzeW5jKG1vZGVsU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3cykpO1xuICAgICAgfVxuXG4gICAgICBQcm9taXNlLmFsbChpbmRleGluZ1Rhc2tzKVxuICAgICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgICAgLy8gZGIgc2NoZW1hIHdhcyB1cGRhdGVkLCBzbyBjYWxsYmFjayB3aXRoIHRydWVcbiAgICAgICAgICBjYWxsYmFjayhudWxsLCB0cnVlKTtcbiAgICAgICAgfSlcbiAgICAgICAgLmNhdGNoKChlcnIyKSA9PiB7XG4gICAgICAgICAgY2FsbGJhY2soZXJyMik7XG4gICAgICAgIH0pO1xuICAgIH07XG5cbiAgICBpZiAoIWRiU2NoZW1hKSB7XG4gICAgICBpZiAocHJvcGVydGllcy5jcmVhdGVUYWJsZSA9PT0gZmFsc2UpIHtcbiAgICAgICAgY2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwudGFibGVjcmVhdGlvbi5zY2hlbWFub3Rmb3VuZCcsIHRhYmxlTmFtZSkpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICAvLyBpZiBub3QgZXhpc3RpbmcsIGl0J3MgY3JlYXRlZFxuICAgICAgdGFibGVCdWlsZGVyLmNyZWF0ZV90YWJsZShtb2RlbFNjaGVtYSwgYWZ0ZXJEQkNyZWF0ZSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgbGV0IG5vcm1hbGl6ZWRNb2RlbFNjaGVtYTtcbiAgICBsZXQgbm9ybWFsaXplZERCU2NoZW1hO1xuXG4gICAgdHJ5IHtcbiAgICAgIG5vcm1hbGl6ZWRNb2RlbFNjaGVtYSA9IG5vcm1hbGl6ZXIubm9ybWFsaXplX21vZGVsX3NjaGVtYShtb2RlbFNjaGVtYSk7XG4gICAgICBub3JtYWxpemVkREJTY2hlbWEgPSBub3JtYWxpemVyLm5vcm1hbGl6ZV9tb2RlbF9zY2hlbWEoZGJTY2hlbWEpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC52YWxpZGF0b3IuaW52YWxpZHNjaGVtYScsIGUubWVzc2FnZSkpO1xuICAgIH1cblxuICAgIGlmIChfLmlzRXF1YWwobm9ybWFsaXplZE1vZGVsU2NoZW1hLCBub3JtYWxpemVkREJTY2hlbWEpKSB7XG4gICAgICAvLyBubyBjaGFuZ2UgaW4gZGIgd2FzIG1hZGUsIHNvIGNhbGxiYWNrIHdpdGggZmFsc2VcbiAgICAgIGNhbGxiYWNrKG51bGwsIGZhbHNlKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBpZiAobWlncmF0aW9uID09PSAnYWx0ZXInKSB7XG4gICAgICAvLyBjaGVjayBpZiB0YWJsZSBjYW4gYmUgYWx0ZXJlZCB0byBtYXRjaCBzY2hlbWFcbiAgICAgIGlmIChfLmlzRXF1YWwobm9ybWFsaXplZE1vZGVsU2NoZW1hLmtleSwgbm9ybWFsaXplZERCU2NoZW1hLmtleSkgJiZcbiAgICAgICAgICBfLmlzRXF1YWwobm9ybWFsaXplZE1vZGVsU2NoZW1hLmNsdXN0ZXJpbmdfb3JkZXIsIG5vcm1hbGl6ZWREQlNjaGVtYS5jbHVzdGVyaW5nX29yZGVyKSkge1xuICAgICAgICB0YWJsZUJ1aWxkZXIuaW5pdF9hbHRlcl9vcGVyYXRpb25zKG1vZGVsU2NoZW1hLCBkYlNjaGVtYSwgbm9ybWFsaXplZE1vZGVsU2NoZW1hLCBub3JtYWxpemVkREJTY2hlbWEsIChlcnIxKSA9PiB7XG4gICAgICAgICAgaWYgKGVycjEgJiYgZXJyMS5tZXNzYWdlID09PSAnYWx0ZXJfaW1wb3NzaWJsZScpIHtcbiAgICAgICAgICAgIHRhYmxlQnVpbGRlci5kcm9wX3JlY3JlYXRlX3RhYmxlKG1vZGVsU2NoZW1hLCBub3JtYWxpemVkREJTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzLCBhZnRlckRCQ3JlYXRlKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9XG4gICAgICAgICAgY2FsbGJhY2soZXJyMSk7XG4gICAgICAgIH0pO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGFibGVCdWlsZGVyLmRyb3BfcmVjcmVhdGVfdGFibGUobW9kZWxTY2hlbWEsIG5vcm1hbGl6ZWREQlNjaGVtYS5tYXRlcmlhbGl6ZWRfdmlld3MsIGFmdGVyREJDcmVhdGUpO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAobWlncmF0aW9uID09PSAnZHJvcCcpIHtcbiAgICAgIHRhYmxlQnVpbGRlci5kcm9wX3JlY3JlYXRlX3RhYmxlKG1vZGVsU2NoZW1hLCBub3JtYWxpemVkREJTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzLCBhZnRlckRCQ3JlYXRlKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwudGFibGVjcmVhdGlvbi5zY2hlbWFtaXNtYXRjaCcsIHRhYmxlTmFtZSwgJ21pZ3JhdGlvbiBzdXNwZW5kZWQsIHBsZWFzZSBhcHBseSB0aGUgY2hhbmdlIG1hbnVhbGx5JykpO1xuICAgIH1cbiAgfSk7XG59O1xuXG5CYXNlTW9kZWwuX3N5bmNfZXNfaW5kZXggPSBmdW5jdGlvbiBmKGNhbGxiYWNrKSB7XG4gIGNvbnN0IHByb3BlcnRpZXMgPSB0aGlzLl9wcm9wZXJ0aWVzO1xuXG4gIGlmIChwcm9wZXJ0aWVzLmVzY2xpZW50ICYmIHByb3BlcnRpZXMuc2NoZW1hLmVzX2luZGV4X21hcHBpbmcpIHtcbiAgICBjb25zdCBrZXlzcGFjZU5hbWUgPSBwcm9wZXJ0aWVzLmtleXNwYWNlO1xuICAgIGNvbnN0IG1hcHBpbmdOYW1lID0gcHJvcGVydGllcy50YWJsZV9uYW1lO1xuICAgIGNvbnN0IGluZGV4TmFtZSA9IGAke2tleXNwYWNlTmFtZX1fJHttYXBwaW5nTmFtZX1gO1xuXG4gICAgY29uc3QgZWxhc3NhbmRyYUJ1aWxkZXIgPSBuZXcgRWxhc3NhbmRyYUJ1aWxkZXIocHJvcGVydGllcy5lc2NsaWVudCk7XG4gICAgZWxhc3NhbmRyYUJ1aWxkZXIuYXNzZXJ0X2luZGV4KGtleXNwYWNlTmFtZSwgaW5kZXhOYW1lLCAoZXJyKSA9PiB7XG4gICAgICBpZiAoZXJyKSB7XG4gICAgICAgIGNhbGxiYWNrKGVycik7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGVsYXNzYW5kcmFCdWlsZGVyLnB1dF9tYXBwaW5nKGluZGV4TmFtZSwgbWFwcGluZ05hbWUsIHByb3BlcnRpZXMuc2NoZW1hLmVzX2luZGV4X21hcHBpbmcsIGNhbGxiYWNrKTtcbiAgICB9KTtcbiAgICByZXR1cm47XG4gIH1cbiAgY2FsbGJhY2soKTtcbn07XG5cbkJhc2VNb2RlbC5fc3luY19ncmFwaCA9IGZ1bmN0aW9uIGYoY2FsbGJhY2spIHtcbiAgY29uc3QgcHJvcGVydGllcyA9IHRoaXMuX3Byb3BlcnRpZXM7XG5cbiAgaWYgKHByb3BlcnRpZXMuZ3JlbWxpbl9jbGllbnQgJiYgcHJvcGVydGllcy5zY2hlbWEuZ3JhcGhfbWFwcGluZykge1xuICAgIGNvbnN0IGdyYXBoTmFtZSA9IGAke3Byb3BlcnRpZXMua2V5c3BhY2V9X2dyYXBoYDtcbiAgICBjb25zdCBtYXBwaW5nTmFtZSA9IHByb3BlcnRpZXMudGFibGVfbmFtZTtcblxuICAgIGNvbnN0IGdyYXBoQnVpbGRlciA9IG5ldyBKYW51c0dyYXBoQnVpbGRlcihwcm9wZXJ0aWVzLmdyZW1saW5fY2xpZW50KTtcbiAgICBncmFwaEJ1aWxkZXIuYXNzZXJ0X2dyYXBoKGdyYXBoTmFtZSwgKGVycikgPT4ge1xuICAgICAgaWYgKGVycikge1xuICAgICAgICBjYWxsYmFjayhlcnIpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBncmFwaEJ1aWxkZXIucHV0X21hcHBpbmcoZ3JhcGhOYW1lLCBtYXBwaW5nTmFtZSwgcHJvcGVydGllcy5zY2hlbWEuZ3JhcGhfbWFwcGluZywgY2FsbGJhY2spO1xuICAgIH0pO1xuICAgIHJldHVybjtcbiAgfVxuICBjYWxsYmFjaygpO1xufTtcblxuQmFzZU1vZGVsLl9leGVjdXRlX3RhYmxlX3F1ZXJ5ID0gZnVuY3Rpb24gZihxdWVyeSwgcGFyYW1zLCBvcHRpb25zLCBjYWxsYmFjaykge1xuICBpZiAoYXJndW1lbnRzLmxlbmd0aCA9PT0gMykge1xuICAgIGNhbGxiYWNrID0gb3B0aW9ucztcbiAgICBvcHRpb25zID0ge307XG4gIH1cblxuICBjb25zdCBkZWZhdWx0cyA9IHtcbiAgICBwcmVwYXJlOiB0cnVlLFxuICB9O1xuXG4gIG9wdGlvbnMgPSBfLmRlZmF1bHRzRGVlcChvcHRpb25zLCBkZWZhdWx0cyk7XG5cbiAgY29uc3QgZG9FeGVjdXRlUXVlcnkgPSBmdW5jdGlvbiBmMShkb3F1ZXJ5LCBkb2NhbGxiYWNrKSB7XG4gICAgdGhpcy5leGVjdXRlX3F1ZXJ5KGRvcXVlcnksIHBhcmFtcywgb3B0aW9ucywgZG9jYWxsYmFjayk7XG4gIH0uYmluZCh0aGlzLCBxdWVyeSk7XG5cbiAgaWYgKHRoaXMuaXNfdGFibGVfcmVhZHkoKSkge1xuICAgIGRvRXhlY3V0ZVF1ZXJ5KGNhbGxiYWNrKTtcbiAgfSBlbHNlIHtcbiAgICB0aGlzLmluaXQoKGVycikgPT4ge1xuICAgICAgaWYgKGVycikge1xuICAgICAgICBjYWxsYmFjayhlcnIpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBkb0V4ZWN1dGVRdWVyeShjYWxsYmFjayk7XG4gICAgfSk7XG4gIH1cbn07XG5cbkJhc2VNb2RlbC5nZXRfZmluZF9xdWVyeSA9IGZ1bmN0aW9uIGYocXVlcnlPYmplY3QsIG9wdGlvbnMpIHtcbiAgY29uc3Qgb3JkZXJieUNsYXVzZSA9IHBhcnNlci5nZXRfb3JkZXJieV9jbGF1c2UocXVlcnlPYmplY3QpO1xuICBjb25zdCBsaW1pdENsYXVzZSA9IHBhcnNlci5nZXRfbGltaXRfY2xhdXNlKHF1ZXJ5T2JqZWN0KTtcbiAgY29uc3Qgd2hlcmVDbGF1c2UgPSBwYXJzZXIuZ2V0X3doZXJlX2NsYXVzZSh0aGlzLl9wcm9wZXJ0aWVzLnNjaGVtYSwgcXVlcnlPYmplY3QpO1xuICBjb25zdCBzZWxlY3RDbGF1c2UgPSBwYXJzZXIuZ2V0X3NlbGVjdF9jbGF1c2Uob3B0aW9ucyk7XG4gIGNvbnN0IGdyb3VwYnlDbGF1c2UgPSBwYXJzZXIuZ2V0X2dyb3VwYnlfY2xhdXNlKG9wdGlvbnMpO1xuXG4gIGxldCBxdWVyeSA9IHV0aWwuZm9ybWF0KFxuICAgICdTRUxFQ1QgJXMlcyBGUk9NIFwiJXNcIicsXG4gICAgKG9wdGlvbnMuZGlzdGluY3QgPyAnRElTVElOQ1QgJyA6ICcnKSxcbiAgICBzZWxlY3RDbGF1c2UsXG4gICAgb3B0aW9ucy5tYXRlcmlhbGl6ZWRfdmlldyA/IG9wdGlvbnMubWF0ZXJpYWxpemVkX3ZpZXcgOiB0aGlzLl9wcm9wZXJ0aWVzLnRhYmxlX25hbWUsXG4gICk7XG5cbiAgaWYgKHdoZXJlQ2xhdXNlLnF1ZXJ5KSBxdWVyeSArPSB1dGlsLmZvcm1hdCgnICVzJywgd2hlcmVDbGF1c2UucXVlcnkpO1xuICBpZiAob3JkZXJieUNsYXVzZSkgcXVlcnkgKz0gdXRpbC5mb3JtYXQoJyAlcycsIG9yZGVyYnlDbGF1c2UpO1xuICBpZiAoZ3JvdXBieUNsYXVzZSkgcXVlcnkgKz0gdXRpbC5mb3JtYXQoJyAlcycsIGdyb3VwYnlDbGF1c2UpO1xuICBpZiAobGltaXRDbGF1c2UpIHF1ZXJ5ICs9IHV0aWwuZm9ybWF0KCcgJXMnLCBsaW1pdENsYXVzZSk7XG4gIGlmIChvcHRpb25zLmFsbG93X2ZpbHRlcmluZykgcXVlcnkgKz0gJyBBTExPVyBGSUxURVJJTkcnO1xuXG4gIHF1ZXJ5ICs9ICc7JztcblxuICByZXR1cm4geyBxdWVyeSwgcGFyYW1zOiB3aGVyZUNsYXVzZS5wYXJhbXMgfTtcbn07XG5cbkJhc2VNb2RlbC5nZXRfdGFibGVfbmFtZSA9IGZ1bmN0aW9uIGYoKSB7XG4gIHJldHVybiB0aGlzLl9wcm9wZXJ0aWVzLnRhYmxlX25hbWU7XG59O1xuXG5CYXNlTW9kZWwuZ2V0X2tleXNwYWNlX25hbWUgPSBmdW5jdGlvbiBmKCkge1xuICByZXR1cm4gdGhpcy5fcHJvcGVydGllcy5rZXlzcGFjZTtcbn07XG5cbkJhc2VNb2RlbC5pc190YWJsZV9yZWFkeSA9IGZ1bmN0aW9uIGYoKSB7XG4gIHJldHVybiB0aGlzLl9yZWFkeSA9PT0gdHJ1ZTtcbn07XG5cbkJhc2VNb2RlbC5pbml0ID0gZnVuY3Rpb24gZihvcHRpb25zLCBjYWxsYmFjaykge1xuICBpZiAoIWNhbGxiYWNrKSB7XG4gICAgY2FsbGJhY2sgPSBvcHRpb25zO1xuICAgIG9wdGlvbnMgPSB1bmRlZmluZWQ7XG4gIH1cblxuICB0aGlzLl9yZWFkeSA9IHRydWU7XG4gIGNhbGxiYWNrKCk7XG59O1xuXG5CYXNlTW9kZWwuc3luY0RCID0gZnVuY3Rpb24gZihjYWxsYmFjaykge1xuICB0aGlzLl9zeW5jX21vZGVsX2RlZmluaXRpb24oKGVyciwgcmVzdWx0KSA9PiB7XG4gICAgaWYgKGVycikge1xuICAgICAgY2FsbGJhY2soZXJyKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICB0aGlzLl9zeW5jX2VzX2luZGV4KChlcnIxKSA9PiB7XG4gICAgICBpZiAoZXJyMSkge1xuICAgICAgICBjYWxsYmFjayhlcnIxKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICB0aGlzLl9zeW5jX2dyYXBoKChlcnIyKSA9PiB7XG4gICAgICAgIGlmIChlcnIyKSB7XG4gICAgICAgICAgY2FsbGJhY2soZXJyMik7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgdGhpcy5fcmVhZHkgPSB0cnVlO1xuICAgICAgICBjYWxsYmFjayhudWxsLCByZXN1bHQpO1xuICAgICAgfSk7XG4gICAgfSk7XG4gIH0pO1xufTtcblxuQmFzZU1vZGVsLmdldF9jcWxfY2xpZW50ID0gZnVuY3Rpb24gZihjYWxsYmFjaykge1xuICB0aGlzLl9kcml2ZXIuZW5zdXJlX2luaXQoKGVycikgPT4ge1xuICAgIGlmIChlcnIpIHtcbiAgICAgIGNhbGxiYWNrKGVycik7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNhbGxiYWNrKG51bGwsIHRoaXMuX3Byb3BlcnRpZXMuY3FsKTtcbiAgfSk7XG59O1xuXG5CYXNlTW9kZWwuZ2V0X2VzX2NsaWVudCA9IGZ1bmN0aW9uIGYoKSB7XG4gIGlmICghdGhpcy5fcHJvcGVydGllcy5lc2NsaWVudCkge1xuICAgIHRocm93IChuZXcgRXJyb3IoJ1RvIHVzZSBlbGFzc2FuZHJhIGZlYXR1cmVzLCBzZXQgYG1hbmFnZUVTSW5kZXhgIHRvIHRydWUgaW4gb3JtT3B0aW9ucycpKTtcbiAgfVxuICByZXR1cm4gdGhpcy5fcHJvcGVydGllcy5lc2NsaWVudDtcbn07XG5cbkJhc2VNb2RlbC5nZXRfZ3JlbWxpbl9jbGllbnQgPSBmdW5jdGlvbiBmKCkge1xuICBpZiAoIXRoaXMuX3Byb3BlcnRpZXMuZ3JlbWxpbl9jbGllbnQpIHtcbiAgICB0aHJvdyAobmV3IEVycm9yKCdUbyB1c2UgamFudXMgZ3JhcGggZmVhdHVyZXMsIHNldCBgbWFuYWdlR3JhcGhzYCB0byB0cnVlIGluIG9ybU9wdGlvbnMnKSk7XG4gIH1cbiAgcmV0dXJuIHRoaXMuX3Byb3BlcnRpZXMuZ3JlbWxpbl9jbGllbnQ7XG59O1xuXG5CYXNlTW9kZWwuZXhlY3V0ZV9xdWVyeSA9IGZ1bmN0aW9uIGYoLi4uYXJncykge1xuICB0aGlzLl9kcml2ZXIuZXhlY3V0ZV9xdWVyeSguLi5hcmdzKTtcbn07XG5cbkJhc2VNb2RlbC5leGVjdXRlX2JhdGNoID0gZnVuY3Rpb24gZiguLi5hcmdzKSB7XG4gIHRoaXMuX2RyaXZlci5leGVjdXRlX2JhdGNoKC4uLmFyZ3MpO1xufTtcblxuQmFzZU1vZGVsLmV4ZWN1dGVfZWFjaFJvdyA9IGZ1bmN0aW9uIGYoLi4uYXJncykge1xuICB0aGlzLl9kcml2ZXIuZXhlY3V0ZV9lYWNoUm93KC4uLmFyZ3MpO1xufTtcblxuQmFzZU1vZGVsLl9leGVjdXRlX3RhYmxlX2VhY2hSb3cgPSBmdW5jdGlvbiBmKHF1ZXJ5LCBwYXJhbXMsIG9wdGlvbnMsIG9uUmVhZGFibGUsIGNhbGxiYWNrKSB7XG4gIGlmICh0aGlzLmlzX3RhYmxlX3JlYWR5KCkpIHtcbiAgICB0aGlzLmV4ZWN1dGVfZWFjaFJvdyhxdWVyeSwgcGFyYW1zLCBvcHRpb25zLCBvblJlYWRhYmxlLCBjYWxsYmFjayk7XG4gIH0gZWxzZSB7XG4gICAgdGhpcy5pbml0KChlcnIpID0+IHtcbiAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgY2FsbGJhY2soZXJyKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgdGhpcy5leGVjdXRlX2VhY2hSb3cocXVlcnksIHBhcmFtcywgb3B0aW9ucywgb25SZWFkYWJsZSwgY2FsbGJhY2spO1xuICAgIH0pO1xuICB9XG59O1xuXG5CYXNlTW9kZWwuZWFjaFJvdyA9IGZ1bmN0aW9uIGYocXVlcnlPYmplY3QsIG9wdGlvbnMsIG9uUmVhZGFibGUsIGNhbGxiYWNrKSB7XG4gIGlmIChhcmd1bWVudHMubGVuZ3RoID09PSAzKSB7XG4gICAgY29uc3QgY2IgPSBvblJlYWRhYmxlO1xuICAgIG9uUmVhZGFibGUgPSBvcHRpb25zO1xuICAgIGNhbGxiYWNrID0gY2I7XG4gICAgb3B0aW9ucyA9IHt9O1xuICB9XG4gIGlmICh0eXBlb2Ygb25SZWFkYWJsZSAhPT0gJ2Z1bmN0aW9uJykge1xuICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5maW5kLmVhY2hyb3dlcnJvcicsICdubyB2YWxpZCBvblJlYWRhYmxlIGZ1bmN0aW9uIHdhcyBwcm92aWRlZCcpKTtcbiAgfVxuICBpZiAodHlwZW9mIGNhbGxiYWNrICE9PSAnZnVuY3Rpb24nKSB7XG4gICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLmZpbmQuY2JlcnJvcicpKTtcbiAgfVxuXG4gIGNvbnN0IGRlZmF1bHRzID0ge1xuICAgIHJhdzogZmFsc2UsXG4gICAgcHJlcGFyZTogdHJ1ZSxcbiAgfTtcblxuICBvcHRpb25zID0gXy5kZWZhdWx0c0RlZXAob3B0aW9ucywgZGVmYXVsdHMpO1xuXG4gIG9wdGlvbnMucmV0dXJuX3F1ZXJ5ID0gdHJ1ZTtcbiAgY29uc3Qgc2VsZWN0UXVlcnkgPSB0aGlzLmZpbmQocXVlcnlPYmplY3QsIG9wdGlvbnMpO1xuXG4gIGNvbnN0IHF1ZXJ5T3B0aW9ucyA9IG5vcm1hbGl6ZXIubm9ybWFsaXplX3F1ZXJ5X29wdGlvbihvcHRpb25zKTtcblxuICB0aGlzLl9leGVjdXRlX3RhYmxlX2VhY2hSb3coc2VsZWN0UXVlcnkucXVlcnksIHNlbGVjdFF1ZXJ5LnBhcmFtcywgcXVlcnlPcHRpb25zLCAobiwgcm93KSA9PiB7XG4gICAgaWYgKCFvcHRpb25zLnJhdykge1xuICAgICAgY29uc3QgTW9kZWxDb25zdHJ1Y3RvciA9IHRoaXMuX3Byb3BlcnRpZXMuZ2V0X2NvbnN0cnVjdG9yKCk7XG4gICAgICByb3cgPSBuZXcgTW9kZWxDb25zdHJ1Y3Rvcihyb3cpO1xuICAgICAgcm93Ll9tb2RpZmllZCA9IHt9O1xuICAgIH1cbiAgICBvblJlYWRhYmxlKG4sIHJvdyk7XG4gIH0sIChlcnIsIHJlc3VsdCkgPT4ge1xuICAgIGlmIChlcnIpIHtcbiAgICAgIGNhbGxiYWNrKGJ1aWxkRXJyb3IoJ21vZGVsLmZpbmQuZGJlcnJvcicsIGVycikpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjYWxsYmFjayhlcnIsIHJlc3VsdCk7XG4gIH0pO1xufTtcblxuQmFzZU1vZGVsLmV4ZWN1dGVfc3RyZWFtID0gZnVuY3Rpb24gZiguLi5hcmdzKSB7XG4gIHRoaXMuX2RyaXZlci5leGVjdXRlX3N0cmVhbSguLi5hcmdzKTtcbn07XG5cbkJhc2VNb2RlbC5fZXhlY3V0ZV90YWJsZV9zdHJlYW0gPSBmdW5jdGlvbiBmKHF1ZXJ5LCBwYXJhbXMsIG9wdGlvbnMsIG9uUmVhZGFibGUsIGNhbGxiYWNrKSB7XG4gIGlmICh0aGlzLmlzX3RhYmxlX3JlYWR5KCkpIHtcbiAgICB0aGlzLmV4ZWN1dGVfc3RyZWFtKHF1ZXJ5LCBwYXJhbXMsIG9wdGlvbnMsIG9uUmVhZGFibGUsIGNhbGxiYWNrKTtcbiAgfSBlbHNlIHtcbiAgICB0aGlzLmluaXQoKGVycikgPT4ge1xuICAgICAgaWYgKGVycikge1xuICAgICAgICBjYWxsYmFjayhlcnIpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICB0aGlzLmV4ZWN1dGVfc3RyZWFtKHF1ZXJ5LCBwYXJhbXMsIG9wdGlvbnMsIG9uUmVhZGFibGUsIGNhbGxiYWNrKTtcbiAgICB9KTtcbiAgfVxufTtcblxuQmFzZU1vZGVsLnN0cmVhbSA9IGZ1bmN0aW9uIGYocXVlcnlPYmplY3QsIG9wdGlvbnMsIG9uUmVhZGFibGUsIGNhbGxiYWNrKSB7XG4gIGlmIChhcmd1bWVudHMubGVuZ3RoID09PSAzKSB7XG4gICAgY29uc3QgY2IgPSBvblJlYWRhYmxlO1xuICAgIG9uUmVhZGFibGUgPSBvcHRpb25zO1xuICAgIGNhbGxiYWNrID0gY2I7XG4gICAgb3B0aW9ucyA9IHt9O1xuICB9XG5cbiAgaWYgKHR5cGVvZiBvblJlYWRhYmxlICE9PSAnZnVuY3Rpb24nKSB7XG4gICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLmZpbmQuc3RyZWFtZXJyb3InLCAnbm8gdmFsaWQgb25SZWFkYWJsZSBmdW5jdGlvbiB3YXMgcHJvdmlkZWQnKSk7XG4gIH1cbiAgaWYgKHR5cGVvZiBjYWxsYmFjayAhPT0gJ2Z1bmN0aW9uJykge1xuICAgIHRocm93IChidWlsZEVycm9yKCdtb2RlbC5maW5kLmNiZXJyb3InKSk7XG4gIH1cblxuICBjb25zdCBkZWZhdWx0cyA9IHtcbiAgICByYXc6IGZhbHNlLFxuICAgIHByZXBhcmU6IHRydWUsXG4gIH07XG5cbiAgb3B0aW9ucyA9IF8uZGVmYXVsdHNEZWVwKG9wdGlvbnMsIGRlZmF1bHRzKTtcblxuICBvcHRpb25zLnJldHVybl9xdWVyeSA9IHRydWU7XG4gIGNvbnN0IHNlbGVjdFF1ZXJ5ID0gdGhpcy5maW5kKHF1ZXJ5T2JqZWN0LCBvcHRpb25zKTtcblxuICBjb25zdCBxdWVyeU9wdGlvbnMgPSBub3JtYWxpemVyLm5vcm1hbGl6ZV9xdWVyeV9vcHRpb24ob3B0aW9ucyk7XG5cbiAgY29uc3Qgc2VsZiA9IHRoaXM7XG5cbiAgdGhpcy5fZXhlY3V0ZV90YWJsZV9zdHJlYW0oc2VsZWN0UXVlcnkucXVlcnksIHNlbGVjdFF1ZXJ5LnBhcmFtcywgcXVlcnlPcHRpb25zLCBmdW5jdGlvbiBmMSgpIHtcbiAgICBjb25zdCByZWFkZXIgPSB0aGlzO1xuICAgIHJlYWRlci5yZWFkUm93ID0gKCkgPT4ge1xuICAgICAgY29uc3Qgcm93ID0gcmVhZGVyLnJlYWQoKTtcbiAgICAgIGlmICghcm93KSByZXR1cm4gcm93O1xuICAgICAgaWYgKCFvcHRpb25zLnJhdykge1xuICAgICAgICBjb25zdCBNb2RlbENvbnN0cnVjdG9yID0gc2VsZi5fcHJvcGVydGllcy5nZXRfY29uc3RydWN0b3IoKTtcbiAgICAgICAgY29uc3QgbyA9IG5ldyBNb2RlbENvbnN0cnVjdG9yKHJvdyk7XG4gICAgICAgIG8uX21vZGlmaWVkID0ge307XG4gICAgICAgIHJldHVybiBvO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHJvdztcbiAgICB9O1xuICAgIG9uUmVhZGFibGUocmVhZGVyKTtcbiAgfSwgKGVycikgPT4ge1xuICAgIGlmIChlcnIpIHtcbiAgICAgIGNhbGxiYWNrKGJ1aWxkRXJyb3IoJ21vZGVsLmZpbmQuZGJlcnJvcicsIGVycikpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjYWxsYmFjaygpO1xuICB9KTtcbn07XG5cbkJhc2VNb2RlbC5fZXhlY3V0ZV9ncmVtbGluX3F1ZXJ5ID0gZnVuY3Rpb24gZihzY3JpcHQsIGJpbmRpbmdzLCBjYWxsYmFjaykge1xuICBjb25zdCBncmVtbGluQ2xpZW50ID0gdGhpcy5nZXRfZ3JlbWxpbl9jbGllbnQoKTtcbiAgZ3JlbWxpbkNsaWVudC5leGVjdXRlKHNjcmlwdCwgYmluZGluZ3MsIChlcnIsIHJlc3VsdHMpID0+IHtcbiAgICBpZiAoZXJyKSB7XG4gICAgICBjYWxsYmFjayhlcnIpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjYWxsYmFjayhudWxsLCByZXN1bHRzKTtcbiAgfSk7XG59O1xuXG5CYXNlTW9kZWwuX2V4ZWN1dGVfZ3JlbWxpbl9zY3JpcHQgPSBmdW5jdGlvbiBmKHNjcmlwdCwgYmluZGluZ3MsIGNhbGxiYWNrKSB7XG4gIHRoaXMuX2V4ZWN1dGVfZ3JlbWxpbl9xdWVyeShzY3JpcHQsIGJpbmRpbmdzLCAoZXJyLCByZXN1bHRzKSA9PiB7XG4gICAgaWYgKGVycikge1xuICAgICAgY2FsbGJhY2soZXJyKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY2FsbGJhY2sobnVsbCwgcmVzdWx0c1swXSk7XG4gIH0pO1xufTtcblxuQmFzZU1vZGVsLmNyZWF0ZVZlcnRleCA9IGZ1bmN0aW9uIGYodmVydGV4UHJvcGVydGllcywgY2FsbGJhY2spIHtcbiAgY29uc3QgcHJvcGVydGllcyA9IHRoaXMuX3Byb3BlcnRpZXM7XG4gIGNvbnN0IF9fZ3JhcGhOYW1lID0gYCR7cHJvcGVydGllcy5rZXlzcGFjZX1fZ3JhcGhgO1xuICBjb25zdCBfX3ZlcnRleExhYmVsID0gcHJvcGVydGllcy50YWJsZV9uYW1lO1xuICBsZXQgc2NyaXB0ID0gYFxuICAgIGdyYXBoID0gQ29uZmlndXJlZEdyYXBoRmFjdG9yeS5vcGVuKF9fZ3JhcGhOYW1lKTtcbiAgICB2ZXJ0ZXggPSBncmFwaC5hZGRWZXJ0ZXgoX192ZXJ0ZXhMYWJlbCk7XG4gIGA7XG4gIE9iamVjdC5rZXlzKHZlcnRleFByb3BlcnRpZXMpLmZvckVhY2goKHByb3BlcnR5KSA9PiB7XG4gICAgc2NyaXB0ICs9IGB2ZXJ0ZXgucHJvcGVydHkoJyR7cHJvcGVydHl9JywgJHtwcm9wZXJ0eX0pO2A7XG4gIH0pO1xuICBzY3JpcHQgKz0gJ3ZlcnRleCc7XG4gIGNvbnN0IGJpbmRpbmdzID0gXy5kZWZhdWx0cyh2ZXJ0ZXhQcm9wZXJ0aWVzLCB7XG4gICAgX19ncmFwaE5hbWUsXG4gICAgX192ZXJ0ZXhMYWJlbCxcbiAgfSk7XG4gIHRoaXMuX2V4ZWN1dGVfZ3JlbWxpbl9zY3JpcHQoc2NyaXB0LCBiaW5kaW5ncywgY2FsbGJhY2spO1xufTtcblxuQmFzZU1vZGVsLmdldFZlcnRleCA9IGZ1bmN0aW9uIGYoX192ZXJ0ZXhJZCwgY2FsbGJhY2spIHtcbiAgY29uc3QgcHJvcGVydGllcyA9IHRoaXMuX3Byb3BlcnRpZXM7XG4gIGNvbnN0IF9fZ3JhcGhOYW1lID0gYCR7cHJvcGVydGllcy5rZXlzcGFjZX1fZ3JhcGhgO1xuICBjb25zdCBzY3JpcHQgPSBgXG4gICAgZ3JhcGggPSBDb25maWd1cmVkR3JhcGhGYWN0b3J5Lm9wZW4oX19ncmFwaE5hbWUpO1xuICAgIGcgPSBncmFwaC50cmF2ZXJzYWwoKTtcbiAgICB2ZXJ0ZXggPSBnLlYoX192ZXJ0ZXhJZCk7XG4gIGA7XG4gIGNvbnN0IGJpbmRpbmdzID0ge1xuICAgIF9fZ3JhcGhOYW1lLFxuICAgIF9fdmVydGV4SWQsXG4gIH07XG4gIHRoaXMuX2V4ZWN1dGVfZ3JlbWxpbl9zY3JpcHQoc2NyaXB0LCBiaW5kaW5ncywgY2FsbGJhY2spO1xufTtcblxuQmFzZU1vZGVsLnVwZGF0ZVZlcnRleCA9IGZ1bmN0aW9uIGYoX192ZXJ0ZXhJZCwgdmVydGV4UHJvcGVydGllcywgY2FsbGJhY2spIHtcbiAgY29uc3QgcHJvcGVydGllcyA9IHRoaXMuX3Byb3BlcnRpZXM7XG4gIGNvbnN0IF9fZ3JhcGhOYW1lID0gYCR7cHJvcGVydGllcy5rZXlzcGFjZX1fZ3JhcGhgO1xuICBsZXQgc2NyaXB0ID0gYFxuICAgIGdyYXBoID0gQ29uZmlndXJlZEdyYXBoRmFjdG9yeS5vcGVuKF9fZ3JhcGhOYW1lKTtcbiAgICBnID0gZ3JhcGgudHJhdmVyc2FsKCk7XG4gICAgdmVydGV4ID0gZy5WKF9fdmVydGV4SWQpO1xuICBgO1xuICBPYmplY3Qua2V5cyh2ZXJ0ZXhQcm9wZXJ0aWVzKS5mb3JFYWNoKChwcm9wZXJ0eSkgPT4ge1xuICAgIHNjcmlwdCArPSBgdmVydGV4LnByb3BlcnR5KCcke3Byb3BlcnR5fScsICR7cHJvcGVydHl9KTtgO1xuICB9KTtcbiAgc2NyaXB0ICs9ICd2ZXJ0ZXgnO1xuICBjb25zdCBiaW5kaW5ncyA9IF8uZGVmYXVsdHModmVydGV4UHJvcGVydGllcywge1xuICAgIF9fZ3JhcGhOYW1lLFxuICAgIF9fdmVydGV4SWQsXG4gIH0pO1xuICB0aGlzLl9leGVjdXRlX2dyZW1saW5fc2NyaXB0KHNjcmlwdCwgYmluZGluZ3MsIGNhbGxiYWNrKTtcbn07XG5cbkJhc2VNb2RlbC5kZWxldGVWZXJ0ZXggPSBmdW5jdGlvbiBmKF9fdmVydGV4SWQsIGNhbGxiYWNrKSB7XG4gIGNvbnN0IHByb3BlcnRpZXMgPSB0aGlzLl9wcm9wZXJ0aWVzO1xuICBjb25zdCBfX2dyYXBoTmFtZSA9IGAke3Byb3BlcnRpZXMua2V5c3BhY2V9X2dyYXBoYDtcbiAgY29uc3Qgc2NyaXB0ID0gYFxuICAgIGdyYXBoID0gQ29uZmlndXJlZEdyYXBoRmFjdG9yeS5vcGVuKF9fZ3JhcGhOYW1lKTtcbiAgICBnID0gZ3JhcGgudHJhdmVyc2FsKCk7XG4gICAgdmVydGV4ID0gZy5WKF9fdmVydGV4SWQpO1xuICAgIHZlcnRleC5kcm9wKCk7XG4gIGA7XG4gIGNvbnN0IGJpbmRpbmdzID0ge1xuICAgIF9fZ3JhcGhOYW1lLFxuICAgIF9fdmVydGV4SWQsXG4gIH07XG4gIHRoaXMuX2V4ZWN1dGVfZ3JlbWxpbl9zY3JpcHQoc2NyaXB0LCBiaW5kaW5ncywgY2FsbGJhY2spO1xufTtcblxuQmFzZU1vZGVsLmNyZWF0ZUVkZ2UgPSBmdW5jdGlvbiBmKF9fZWRnZUxhYmVsLCBfX2Zyb21WZXJ0ZXhJZCwgX190b1ZlcnRleElkLCBlZGdlUHJvcGVydGllcywgY2FsbGJhY2spIHtcbiAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPT09IDQgJiYgdHlwZW9mIGVkZ2VQcm9wZXJ0aWVzID09PSAnZnVuY3Rpb24nKSB7XG4gICAgY2FsbGJhY2sgPSBlZGdlUHJvcGVydGllcztcbiAgICBlZGdlUHJvcGVydGllcyA9IHt9O1xuICB9XG4gIGNvbnN0IHByb3BlcnRpZXMgPSB0aGlzLl9wcm9wZXJ0aWVzO1xuICBjb25zdCBfX2dyYXBoTmFtZSA9IGAke3Byb3BlcnRpZXMua2V5c3BhY2V9X2dyYXBoYDtcbiAgbGV0IHNjcmlwdCA9IGBcbiAgICBncmFwaCA9IENvbmZpZ3VyZWRHcmFwaEZhY3Rvcnkub3BlbihfX2dyYXBoTmFtZSk7XG4gICAgZyA9IGdyYXBoLnRyYXZlcnNhbCgpO1xuICAgIGZyb21WZXJ0ZXggPSBnLlYoX19mcm9tVmVydGV4SWQpLm5leHQoKTtcbiAgICB0b1ZlcnRleCA9IGcuVihfX3RvVmVydGV4SWQpLm5leHQoKTtcbiAgICBlZGdlID0gZnJvbVZlcnRleC5hZGRFZGdlKF9fZWRnZUxhYmVsLCB0b1ZlcnRleCk7XG4gIGA7XG4gIE9iamVjdC5rZXlzKGVkZ2VQcm9wZXJ0aWVzKS5mb3JFYWNoKChwcm9wZXJ0eSkgPT4ge1xuICAgIHNjcmlwdCArPSBgZWRnZS5wcm9wZXJ0eSgnJHtwcm9wZXJ0eX0nLCAke3Byb3BlcnR5fSk7YDtcbiAgfSk7XG4gIHNjcmlwdCArPSAnZWRnZSc7XG4gIGNvbnN0IGJpbmRpbmdzID0gXy5kZWZhdWx0cyhlZGdlUHJvcGVydGllcywge1xuICAgIF9fZ3JhcGhOYW1lLFxuICAgIF9fZnJvbVZlcnRleElkLFxuICAgIF9fdG9WZXJ0ZXhJZCxcbiAgICBfX2VkZ2VMYWJlbCxcbiAgfSk7XG4gIHRoaXMuX2V4ZWN1dGVfZ3JlbWxpbl9zY3JpcHQoc2NyaXB0LCBiaW5kaW5ncywgY2FsbGJhY2spO1xufTtcblxuQmFzZU1vZGVsLmdldEVkZ2UgPSBmdW5jdGlvbiBmKF9fZWRnZUlkLCBjYWxsYmFjaykge1xuICBjb25zdCBwcm9wZXJ0aWVzID0gdGhpcy5fcHJvcGVydGllcztcbiAgY29uc3QgX19ncmFwaE5hbWUgPSBgJHtwcm9wZXJ0aWVzLmtleXNwYWNlfV9ncmFwaGA7XG4gIGNvbnN0IHNjcmlwdCA9IGBcbiAgICBncmFwaCA9IENvbmZpZ3VyZWRHcmFwaEZhY3Rvcnkub3BlbihfX2dyYXBoTmFtZSk7XG4gICAgZyA9IGdyYXBoLnRyYXZlcnNhbCgpO1xuICAgIGVkZ2UgPSBnLkUoX19lZGdlSWQpO1xuICBgO1xuICBjb25zdCBiaW5kaW5ncyA9IHtcbiAgICBfX2dyYXBoTmFtZSxcbiAgICBfX2VkZ2VJZCxcbiAgfTtcbiAgdGhpcy5fZXhlY3V0ZV9ncmVtbGluX3NjcmlwdChzY3JpcHQsIGJpbmRpbmdzLCBjYWxsYmFjayk7XG59O1xuXG5CYXNlTW9kZWwudXBkYXRlRWRnZSA9IGZ1bmN0aW9uIGYoX19lZGdlSWQsIGVkZ2VQcm9wZXJ0aWVzLCBjYWxsYmFjaykge1xuICBjb25zdCBwcm9wZXJ0aWVzID0gdGhpcy5fcHJvcGVydGllcztcbiAgY29uc3QgX19ncmFwaE5hbWUgPSBgJHtwcm9wZXJ0aWVzLmtleXNwYWNlfV9ncmFwaGA7XG4gIGxldCBzY3JpcHQgPSBgXG4gICAgZ3JhcGggPSBDb25maWd1cmVkR3JhcGhGYWN0b3J5Lm9wZW4oX19ncmFwaE5hbWUpO1xuICAgIGcgPSBncmFwaC50cmF2ZXJzYWwoKTtcbiAgICBlZGdlID0gZy5FKF9fZWRnZUlkKTtcbiAgYDtcbiAgT2JqZWN0LmtleXMoZWRnZVByb3BlcnRpZXMpLmZvckVhY2goKHByb3BlcnR5KSA9PiB7XG4gICAgc2NyaXB0ICs9IGBlZGdlLnByb3BlcnR5KCcke3Byb3BlcnR5fScsICR7cHJvcGVydHl9KTtgO1xuICB9KTtcbiAgc2NyaXB0ICs9ICdlZGdlJztcbiAgY29uc3QgYmluZGluZ3MgPSBfLmRlZmF1bHRzKGVkZ2VQcm9wZXJ0aWVzLCB7XG4gICAgX19ncmFwaE5hbWUsXG4gICAgX19lZGdlSWQsXG4gIH0pO1xuICB0aGlzLl9leGVjdXRlX2dyZW1saW5fc2NyaXB0KHNjcmlwdCwgYmluZGluZ3MsIGNhbGxiYWNrKTtcbn07XG5cbkJhc2VNb2RlbC5kZWxldGVFZGdlID0gZnVuY3Rpb24gZihfX2VkZ2VJZCwgY2FsbGJhY2spIHtcbiAgY29uc3QgcHJvcGVydGllcyA9IHRoaXMuX3Byb3BlcnRpZXM7XG4gIGNvbnN0IF9fZ3JhcGhOYW1lID0gYCR7cHJvcGVydGllcy5rZXlzcGFjZX1fZ3JhcGhgO1xuICBjb25zdCBzY3JpcHQgPSBgXG4gICAgZ3JhcGggPSBDb25maWd1cmVkR3JhcGhGYWN0b3J5Lm9wZW4oX19ncmFwaE5hbWUpO1xuICAgIGcgPSBncmFwaC50cmF2ZXJzYWwoKTtcbiAgICBlZGdlID0gZy5FKF9fZWRnZUlkKTtcbiAgICBlZGdlLmRyb3AoKTtcbiAgYDtcbiAgY29uc3QgYmluZGluZ3MgPSB7XG4gICAgX19ncmFwaE5hbWUsXG4gICAgX19lZGdlSWQsXG4gIH07XG4gIHRoaXMuX2V4ZWN1dGVfZ3JlbWxpbl9zY3JpcHQoc2NyaXB0LCBiaW5kaW5ncywgY2FsbGJhY2spO1xufTtcblxuQmFzZU1vZGVsLmdyYXBoUXVlcnkgPSBmdW5jdGlvbiBmKHF1ZXJ5LCBwYXJhbXMsIGNhbGxiYWNrKSB7XG4gIGNvbnN0IHByb3BlcnRpZXMgPSB0aGlzLl9wcm9wZXJ0aWVzO1xuICBjb25zdCBfX2dyYXBoTmFtZSA9IGAke3Byb3BlcnRpZXMua2V5c3BhY2V9X2dyYXBoYDtcbiAgY29uc3QgX192ZXJ0ZXhMYWJlbCA9IHByb3BlcnRpZXMudGFibGVfbmFtZTtcbiAgbGV0IHNjcmlwdCA9IGBcbiAgICBncmFwaCA9IENvbmZpZ3VyZWRHcmFwaEZhY3Rvcnkub3BlbihfX2dyYXBoTmFtZSk7XG4gICAgZyA9IGdyYXBoLnRyYXZlcnNhbCgpO1xuICAgIHZlcnRpY2VzID0gZy5WKCkuaGFzTGFiZWwoX192ZXJ0ZXhMYWJlbCk7XG4gIGA7XG4gIHNjcmlwdCArPSBxdWVyeTtcbiAgY29uc3QgYmluZGluZ3MgPSBfLmRlZmF1bHRzKHBhcmFtcywge1xuICAgIF9fZ3JhcGhOYW1lLFxuICAgIF9fdmVydGV4TGFiZWwsXG4gIH0pO1xuICB0aGlzLl9leGVjdXRlX2dyZW1saW5fcXVlcnkoc2NyaXB0LCBiaW5kaW5ncywgY2FsbGJhY2spO1xufTtcblxuQmFzZU1vZGVsLnNlYXJjaCA9IGZ1bmN0aW9uIGYocXVlcnlPYmplY3QsIGNhbGxiYWNrKSB7XG4gIGNvbnN0IGVzQ2xpZW50ID0gdGhpcy5nZXRfZXNfY2xpZW50KCk7XG4gIGNvbnN0IGluZGV4TmFtZSA9IGAke3RoaXMuX3Byb3BlcnRpZXMua2V5c3BhY2V9XyR7dGhpcy5fcHJvcGVydGllcy50YWJsZV9uYW1lfWA7XG5cbiAgY29uc3QgcXVlcnkgPSBfLmRlZmF1bHRzKHF1ZXJ5T2JqZWN0LCB7XG4gICAgaW5kZXg6IGluZGV4TmFtZSxcbiAgICB0eXBlOiB0aGlzLl9wcm9wZXJ0aWVzLnRhYmxlX25hbWUsXG4gIH0pO1xuICBlc0NsaWVudC5zZWFyY2gocXVlcnksIChlcnIsIHJlc3BvbnNlKSA9PiB7XG4gICAgaWYgKGVycikge1xuICAgICAgY2FsbGJhY2soZXJyKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY2FsbGJhY2sobnVsbCwgcmVzcG9uc2UpO1xuICB9KTtcbn07XG5cbkJhc2VNb2RlbC5maW5kID0gZnVuY3Rpb24gZihxdWVyeU9iamVjdCwgb3B0aW9ucywgY2FsbGJhY2spIHtcbiAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPT09IDIgJiYgdHlwZW9mIG9wdGlvbnMgPT09ICdmdW5jdGlvbicpIHtcbiAgICBjYWxsYmFjayA9IG9wdGlvbnM7XG4gICAgb3B0aW9ucyA9IHt9O1xuICB9XG4gIGlmICh0eXBlb2YgY2FsbGJhY2sgIT09ICdmdW5jdGlvbicgJiYgIW9wdGlvbnMucmV0dXJuX3F1ZXJ5KSB7XG4gICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLmZpbmQuY2JlcnJvcicpKTtcbiAgfVxuXG4gIGNvbnN0IGRlZmF1bHRzID0ge1xuICAgIHJhdzogZmFsc2UsXG4gICAgcHJlcGFyZTogdHJ1ZSxcbiAgfTtcblxuICBvcHRpb25zID0gXy5kZWZhdWx0c0RlZXAob3B0aW9ucywgZGVmYXVsdHMpO1xuXG4gIC8vIHNldCByYXcgdHJ1ZSBpZiBzZWxlY3QgaXMgdXNlZCxcbiAgLy8gYmVjYXVzZSBjYXN0aW5nIHRvIG1vZGVsIGluc3RhbmNlcyBtYXkgbGVhZCB0byBwcm9ibGVtc1xuICBpZiAob3B0aW9ucy5zZWxlY3QpIG9wdGlvbnMucmF3ID0gdHJ1ZTtcblxuICBsZXQgcXVlcnlQYXJhbXMgPSBbXTtcblxuICBsZXQgcXVlcnk7XG4gIHRyeSB7XG4gICAgY29uc3QgZmluZFF1ZXJ5ID0gdGhpcy5nZXRfZmluZF9xdWVyeShxdWVyeU9iamVjdCwgb3B0aW9ucyk7XG4gICAgcXVlcnkgPSBmaW5kUXVlcnkucXVlcnk7XG4gICAgcXVlcnlQYXJhbXMgPSBxdWVyeVBhcmFtcy5jb25jYXQoZmluZFF1ZXJ5LnBhcmFtcyk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBwYXJzZXIuY2FsbGJhY2tfb3JfdGhyb3coZSwgY2FsbGJhY2spO1xuICAgIHJldHVybiB7fTtcbiAgfVxuXG4gIGlmIChvcHRpb25zLnJldHVybl9xdWVyeSkge1xuICAgIHJldHVybiB7IHF1ZXJ5LCBwYXJhbXM6IHF1ZXJ5UGFyYW1zIH07XG4gIH1cblxuICBjb25zdCBxdWVyeU9wdGlvbnMgPSBub3JtYWxpemVyLm5vcm1hbGl6ZV9xdWVyeV9vcHRpb24ob3B0aW9ucyk7XG5cbiAgdGhpcy5fZXhlY3V0ZV90YWJsZV9xdWVyeShxdWVyeSwgcXVlcnlQYXJhbXMsIHF1ZXJ5T3B0aW9ucywgKGVyciwgcmVzdWx0cykgPT4ge1xuICAgIGlmIChlcnIpIHtcbiAgICAgIGNhbGxiYWNrKGJ1aWxkRXJyb3IoJ21vZGVsLmZpbmQuZGJlcnJvcicsIGVycikpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAoIW9wdGlvbnMucmF3KSB7XG4gICAgICBjb25zdCBNb2RlbENvbnN0cnVjdG9yID0gdGhpcy5fcHJvcGVydGllcy5nZXRfY29uc3RydWN0b3IoKTtcbiAgICAgIHJlc3VsdHMgPSByZXN1bHRzLnJvd3MubWFwKChyZXMpID0+IHtcbiAgICAgICAgZGVsZXRlIChyZXMuY29sdW1ucyk7XG4gICAgICAgIGNvbnN0IG8gPSBuZXcgTW9kZWxDb25zdHJ1Y3RvcihyZXMpO1xuICAgICAgICBvLl9tb2RpZmllZCA9IHt9O1xuICAgICAgICByZXR1cm4gbztcbiAgICAgIH0pO1xuICAgICAgY2FsbGJhY2sobnVsbCwgcmVzdWx0cyk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHJlc3VsdHMgPSByZXN1bHRzLnJvd3MubWFwKChyZXMpID0+IHtcbiAgICAgICAgZGVsZXRlIChyZXMuY29sdW1ucyk7XG4gICAgICAgIHJldHVybiByZXM7XG4gICAgICB9KTtcbiAgICAgIGNhbGxiYWNrKG51bGwsIHJlc3VsdHMpO1xuICAgIH1cbiAgfSk7XG5cbiAgcmV0dXJuIHt9O1xufTtcblxuQmFzZU1vZGVsLmZpbmRPbmUgPSBmdW5jdGlvbiBmKHF1ZXJ5T2JqZWN0LCBvcHRpb25zLCBjYWxsYmFjaykge1xuICBpZiAoYXJndW1lbnRzLmxlbmd0aCA9PT0gMiAmJiB0eXBlb2Ygb3B0aW9ucyA9PT0gJ2Z1bmN0aW9uJykge1xuICAgIGNhbGxiYWNrID0gb3B0aW9ucztcbiAgICBvcHRpb25zID0ge307XG4gIH1cbiAgaWYgKHR5cGVvZiBjYWxsYmFjayAhPT0gJ2Z1bmN0aW9uJyAmJiAhb3B0aW9ucy5yZXR1cm5fcXVlcnkpIHtcbiAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwuZmluZC5jYmVycm9yJykpO1xuICB9XG5cbiAgcXVlcnlPYmplY3QuJGxpbWl0ID0gMTtcblxuICByZXR1cm4gdGhpcy5maW5kKHF1ZXJ5T2JqZWN0LCBvcHRpb25zLCAoZXJyLCByZXN1bHRzKSA9PiB7XG4gICAgaWYgKGVycikge1xuICAgICAgY2FsbGJhY2soZXJyKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlc3VsdHMubGVuZ3RoID4gMCkge1xuICAgICAgY2FsbGJhY2sobnVsbCwgcmVzdWx0c1swXSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNhbGxiYWNrKCk7XG4gIH0pO1xufTtcblxuQmFzZU1vZGVsLnVwZGF0ZSA9IGZ1bmN0aW9uIGYocXVlcnlPYmplY3QsIHVwZGF0ZVZhbHVlcywgb3B0aW9ucywgY2FsbGJhY2spIHtcbiAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPT09IDMgJiYgdHlwZW9mIG9wdGlvbnMgPT09ICdmdW5jdGlvbicpIHtcbiAgICBjYWxsYmFjayA9IG9wdGlvbnM7XG4gICAgb3B0aW9ucyA9IHt9O1xuICB9XG5cbiAgY29uc3Qgc2NoZW1hID0gdGhpcy5fcHJvcGVydGllcy5zY2hlbWE7XG5cbiAgY29uc3QgZGVmYXVsdHMgPSB7XG4gICAgcHJlcGFyZTogdHJ1ZSxcbiAgfTtcblxuICBvcHRpb25zID0gXy5kZWZhdWx0c0RlZXAob3B0aW9ucywgZGVmYXVsdHMpO1xuXG4gIGlmICh0eXBlb2Ygc2NoZW1hLmJlZm9yZV91cGRhdGUgPT09ICdmdW5jdGlvbicgJiYgc2NoZW1hLmJlZm9yZV91cGRhdGUocXVlcnlPYmplY3QsIHVwZGF0ZVZhbHVlcywgb3B0aW9ucykgPT09IGZhbHNlKSB7XG4gICAgcGFyc2VyLmNhbGxiYWNrX29yX3Rocm93KGJ1aWxkRXJyb3IoJ21vZGVsLnVwZGF0ZS5iZWZvcmUuZXJyb3InKSwgY2FsbGJhY2spO1xuICAgIHJldHVybiB7fTtcbiAgfVxuXG4gIGNvbnN0IHsgdXBkYXRlQ2xhdXNlcywgcXVlcnlQYXJhbXMsIGVycm9ySGFwcGVuZWQgfSA9IHBhcnNlci5nZXRfdXBkYXRlX3ZhbHVlX2V4cHJlc3Npb24oXG4gICAgdGhpcyxcbiAgICBzY2hlbWEsXG4gICAgdXBkYXRlVmFsdWVzLFxuICAgIGNhbGxiYWNrLFxuICApO1xuXG4gIGlmIChlcnJvckhhcHBlbmVkKSByZXR1cm4ge307XG5cbiAgbGV0IHF1ZXJ5ID0gJ1VQREFURSBcIiVzXCInO1xuICBsZXQgZmluYWxQYXJhbXMgPSBxdWVyeVBhcmFtcztcbiAgaWYgKF8uaXNOdW1iZXIob3B0aW9ucy50dGwpKSB7XG4gICAgcXVlcnkgKz0gJyBVU0lORyBUVEwgPyc7XG4gICAgZmluYWxQYXJhbXMgPSBbb3B0aW9ucy50dGxdLmNvbmNhdChmaW5hbFBhcmFtcyk7XG4gIH1cbiAgcXVlcnkgKz0gJyBTRVQgJXMgJXMnO1xuXG4gIGxldCB3aGVyZSA9ICcnO1xuICB0cnkge1xuICAgIGNvbnN0IHdoZXJlQ2xhdXNlID0gcGFyc2VyLmdldF93aGVyZV9jbGF1c2Uoc2NoZW1hLCBxdWVyeU9iamVjdCk7XG4gICAgd2hlcmUgPSB3aGVyZUNsYXVzZS5xdWVyeTtcbiAgICBmaW5hbFBhcmFtcyA9IGZpbmFsUGFyYW1zLmNvbmNhdCh3aGVyZUNsYXVzZS5wYXJhbXMpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgcGFyc2VyLmNhbGxiYWNrX29yX3Rocm93KGUsIGNhbGxiYWNrKTtcbiAgICByZXR1cm4ge307XG4gIH1cblxuICBxdWVyeSA9IHV0aWwuZm9ybWF0KHF1ZXJ5LCB0aGlzLl9wcm9wZXJ0aWVzLnRhYmxlX25hbWUsIHVwZGF0ZUNsYXVzZXMuam9pbignLCAnKSwgd2hlcmUpO1xuXG4gIGlmIChvcHRpb25zLmNvbmRpdGlvbnMpIHtcbiAgICBjb25zdCBpZkNsYXVzZSA9IHBhcnNlci5nZXRfaWZfY2xhdXNlKHNjaGVtYSwgb3B0aW9ucy5jb25kaXRpb25zKTtcbiAgICBpZiAoaWZDbGF1c2UucXVlcnkpIHtcbiAgICAgIHF1ZXJ5ICs9IHV0aWwuZm9ybWF0KCcgJXMnLCBpZkNsYXVzZS5xdWVyeSk7XG4gICAgICBmaW5hbFBhcmFtcyA9IGZpbmFsUGFyYW1zLmNvbmNhdChpZkNsYXVzZS5wYXJhbXMpO1xuICAgIH1cbiAgfSBlbHNlIGlmIChvcHRpb25zLmlmX2V4aXN0cykge1xuICAgIHF1ZXJ5ICs9ICcgSUYgRVhJU1RTJztcbiAgfVxuXG4gIHF1ZXJ5ICs9ICc7JztcblxuICBpZiAob3B0aW9ucy5yZXR1cm5fcXVlcnkpIHtcbiAgICBjb25zdCByZXR1cm5PYmogPSB7XG4gICAgICBxdWVyeSxcbiAgICAgIHBhcmFtczogZmluYWxQYXJhbXMsXG4gICAgICBhZnRlcl9ob29rOiAoKSA9PiB7XG4gICAgICAgIGlmICh0eXBlb2Ygc2NoZW1hLmFmdGVyX3VwZGF0ZSA9PT0gJ2Z1bmN0aW9uJyAmJiBzY2hlbWEuYWZ0ZXJfdXBkYXRlKHF1ZXJ5T2JqZWN0LCB1cGRhdGVWYWx1ZXMsIG9wdGlvbnMpID09PSBmYWxzZSkge1xuICAgICAgICAgIHJldHVybiBidWlsZEVycm9yKCdtb2RlbC51cGRhdGUuYWZ0ZXIuZXJyb3InKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH0sXG4gICAgfTtcbiAgICByZXR1cm4gcmV0dXJuT2JqO1xuICB9XG5cbiAgY29uc3QgcXVlcnlPcHRpb25zID0gbm9ybWFsaXplci5ub3JtYWxpemVfcXVlcnlfb3B0aW9uKG9wdGlvbnMpO1xuXG4gIHRoaXMuX2V4ZWN1dGVfdGFibGVfcXVlcnkocXVlcnksIGZpbmFsUGFyYW1zLCBxdWVyeU9wdGlvbnMsIChlcnIsIHJlc3VsdHMpID0+IHtcbiAgICBpZiAodHlwZW9mIGNhbGxiYWNrID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICBpZiAoZXJyKSB7XG4gICAgICAgIGNhbGxiYWNrKGJ1aWxkRXJyb3IoJ21vZGVsLnVwZGF0ZS5kYmVycm9yJywgZXJyKSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGlmICh0eXBlb2Ygc2NoZW1hLmFmdGVyX3VwZGF0ZSA9PT0gJ2Z1bmN0aW9uJyAmJiBzY2hlbWEuYWZ0ZXJfdXBkYXRlKHF1ZXJ5T2JqZWN0LCB1cGRhdGVWYWx1ZXMsIG9wdGlvbnMpID09PSBmYWxzZSkge1xuICAgICAgICBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC51cGRhdGUuYWZ0ZXIuZXJyb3InKSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhbGxiYWNrKG51bGwsIHJlc3VsdHMpO1xuICAgIH0gZWxzZSBpZiAoZXJyKSB7XG4gICAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwudXBkYXRlLmRiZXJyb3InLCBlcnIpKTtcbiAgICB9IGVsc2UgaWYgKHR5cGVvZiBzY2hlbWEuYWZ0ZXJfdXBkYXRlID09PSAnZnVuY3Rpb24nICYmIHNjaGVtYS5hZnRlcl91cGRhdGUocXVlcnlPYmplY3QsIHVwZGF0ZVZhbHVlcywgb3B0aW9ucykgPT09IGZhbHNlKSB7XG4gICAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwudXBkYXRlLmFmdGVyLmVycm9yJykpO1xuICAgIH1cbiAgfSk7XG5cbiAgcmV0dXJuIHt9O1xufTtcblxuQmFzZU1vZGVsLmRlbGV0ZSA9IGZ1bmN0aW9uIGYocXVlcnlPYmplY3QsIG9wdGlvbnMsIGNhbGxiYWNrKSB7XG4gIGlmIChhcmd1bWVudHMubGVuZ3RoID09PSAyICYmIHR5cGVvZiBvcHRpb25zID09PSAnZnVuY3Rpb24nKSB7XG4gICAgY2FsbGJhY2sgPSBvcHRpb25zO1xuICAgIG9wdGlvbnMgPSB7fTtcbiAgfVxuXG4gIGNvbnN0IHNjaGVtYSA9IHRoaXMuX3Byb3BlcnRpZXMuc2NoZW1hO1xuXG4gIGNvbnN0IGRlZmF1bHRzID0ge1xuICAgIHByZXBhcmU6IHRydWUsXG4gIH07XG5cbiAgb3B0aW9ucyA9IF8uZGVmYXVsdHNEZWVwKG9wdGlvbnMsIGRlZmF1bHRzKTtcblxuICBpZiAodHlwZW9mIHNjaGVtYS5iZWZvcmVfZGVsZXRlID09PSAnZnVuY3Rpb24nICYmIHNjaGVtYS5iZWZvcmVfZGVsZXRlKHF1ZXJ5T2JqZWN0LCBvcHRpb25zKSA9PT0gZmFsc2UpIHtcbiAgICBwYXJzZXIuY2FsbGJhY2tfb3JfdGhyb3coYnVpbGRFcnJvcignbW9kZWwuZGVsZXRlLmJlZm9yZS5lcnJvcicpLCBjYWxsYmFjayk7XG4gICAgcmV0dXJuIHt9O1xuICB9XG5cbiAgbGV0IHF1ZXJ5UGFyYW1zID0gW107XG5cbiAgbGV0IHF1ZXJ5ID0gJ0RFTEVURSBGUk9NIFwiJXNcIiAlczsnO1xuICBsZXQgd2hlcmUgPSAnJztcbiAgdHJ5IHtcbiAgICBjb25zdCB3aGVyZUNsYXVzZSA9IHBhcnNlci5nZXRfd2hlcmVfY2xhdXNlKHNjaGVtYSwgcXVlcnlPYmplY3QpO1xuICAgIHdoZXJlID0gd2hlcmVDbGF1c2UucXVlcnk7XG4gICAgcXVlcnlQYXJhbXMgPSBxdWVyeVBhcmFtcy5jb25jYXQod2hlcmVDbGF1c2UucGFyYW1zKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHBhcnNlci5jYWxsYmFja19vcl90aHJvdyhlLCBjYWxsYmFjayk7XG4gICAgcmV0dXJuIHt9O1xuICB9XG5cbiAgcXVlcnkgPSB1dGlsLmZvcm1hdChxdWVyeSwgdGhpcy5fcHJvcGVydGllcy50YWJsZV9uYW1lLCB3aGVyZSk7XG5cbiAgaWYgKG9wdGlvbnMucmV0dXJuX3F1ZXJ5KSB7XG4gICAgY29uc3QgcmV0dXJuT2JqID0ge1xuICAgICAgcXVlcnksXG4gICAgICBwYXJhbXM6IHF1ZXJ5UGFyYW1zLFxuICAgICAgYWZ0ZXJfaG9vazogKCkgPT4ge1xuICAgICAgICBpZiAodHlwZW9mIHNjaGVtYS5hZnRlcl9kZWxldGUgPT09ICdmdW5jdGlvbicgJiYgc2NoZW1hLmFmdGVyX2RlbGV0ZShxdWVyeU9iamVjdCwgb3B0aW9ucykgPT09IGZhbHNlKSB7XG4gICAgICAgICAgcmV0dXJuIGJ1aWxkRXJyb3IoJ21vZGVsLmRlbGV0ZS5hZnRlci5lcnJvcicpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfSxcbiAgICB9O1xuICAgIHJldHVybiByZXR1cm5PYmo7XG4gIH1cblxuICBjb25zdCBxdWVyeU9wdGlvbnMgPSBub3JtYWxpemVyLm5vcm1hbGl6ZV9xdWVyeV9vcHRpb24ob3B0aW9ucyk7XG5cbiAgdGhpcy5fZXhlY3V0ZV90YWJsZV9xdWVyeShxdWVyeSwgcXVlcnlQYXJhbXMsIHF1ZXJ5T3B0aW9ucywgKGVyciwgcmVzdWx0cykgPT4ge1xuICAgIGlmICh0eXBlb2YgY2FsbGJhY2sgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgIGlmIChlcnIpIHtcbiAgICAgICAgY2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwuZGVsZXRlLmRiZXJyb3InLCBlcnIpKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgaWYgKHR5cGVvZiBzY2hlbWEuYWZ0ZXJfZGVsZXRlID09PSAnZnVuY3Rpb24nICYmIHNjaGVtYS5hZnRlcl9kZWxldGUocXVlcnlPYmplY3QsIG9wdGlvbnMpID09PSBmYWxzZSkge1xuICAgICAgICBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC5kZWxldGUuYWZ0ZXIuZXJyb3InKSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhbGxiYWNrKG51bGwsIHJlc3VsdHMpO1xuICAgIH0gZWxzZSBpZiAoZXJyKSB7XG4gICAgICB0aHJvdyAoYnVpbGRFcnJvcignbW9kZWwuZGVsZXRlLmRiZXJyb3InLCBlcnIpKTtcbiAgICB9IGVsc2UgaWYgKHR5cGVvZiBzY2hlbWEuYWZ0ZXJfZGVsZXRlID09PSAnZnVuY3Rpb24nICYmIHNjaGVtYS5hZnRlcl9kZWxldGUocXVlcnlPYmplY3QsIG9wdGlvbnMpID09PSBmYWxzZSkge1xuICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLmRlbGV0ZS5hZnRlci5lcnJvcicpKTtcbiAgICB9XG4gIH0pO1xuXG4gIHJldHVybiB7fTtcbn07XG5cbkJhc2VNb2RlbC50cnVuY2F0ZSA9IGZ1bmN0aW9uIGYoY2FsbGJhY2spIHtcbiAgY29uc3QgcHJvcGVydGllcyA9IHRoaXMuX3Byb3BlcnRpZXM7XG4gIGNvbnN0IHRhYmxlTmFtZSA9IHByb3BlcnRpZXMudGFibGVfbmFtZTtcblxuICBjb25zdCBxdWVyeSA9IHV0aWwuZm9ybWF0KCdUUlVOQ0FURSBUQUJMRSBcIiVzXCI7JywgdGFibGVOYW1lKTtcbiAgdGhpcy5fZXhlY3V0ZV90YWJsZV9xdWVyeShxdWVyeSwgW10sIGNhbGxiYWNrKTtcbn07XG5cbkJhc2VNb2RlbC5wcm90b3R5cGUuZ2V0X2RhdGFfdHlwZXMgPSBmdW5jdGlvbiBmKCkge1xuICByZXR1cm4gY3FsLnR5cGVzO1xufTtcblxuQmFzZU1vZGVsLnByb3RvdHlwZS5nZXRfdGFibGVfbmFtZSA9IGZ1bmN0aW9uIGYoKSB7XG4gIHJldHVybiB0aGlzLmNvbnN0cnVjdG9yLmdldF90YWJsZV9uYW1lKCk7XG59O1xuXG5CYXNlTW9kZWwucHJvdG90eXBlLmdldF9rZXlzcGFjZV9uYW1lID0gZnVuY3Rpb24gZigpIHtcbiAgcmV0dXJuIHRoaXMuY29uc3RydWN0b3IuZ2V0X2tleXNwYWNlX25hbWUoKTtcbn07XG5cbkJhc2VNb2RlbC5wcm90b3R5cGUuX2dldF9kZWZhdWx0X3ZhbHVlID0gZnVuY3Rpb24gZihmaWVsZG5hbWUpIHtcbiAgY29uc3QgcHJvcGVydGllcyA9IHRoaXMuY29uc3RydWN0b3IuX3Byb3BlcnRpZXM7XG4gIGNvbnN0IHNjaGVtYSA9IHByb3BlcnRpZXMuc2NoZW1hO1xuXG4gIGlmIChfLmlzUGxhaW5PYmplY3Qoc2NoZW1hLmZpZWxkc1tmaWVsZG5hbWVdKSAmJiBzY2hlbWEuZmllbGRzW2ZpZWxkbmFtZV0uZGVmYXVsdCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgaWYgKHR5cGVvZiBzY2hlbWEuZmllbGRzW2ZpZWxkbmFtZV0uZGVmYXVsdCA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgcmV0dXJuIHNjaGVtYS5maWVsZHNbZmllbGRuYW1lXS5kZWZhdWx0LmNhbGwodGhpcyk7XG4gICAgfVxuICAgIHJldHVybiBzY2hlbWEuZmllbGRzW2ZpZWxkbmFtZV0uZGVmYXVsdDtcbiAgfVxuICByZXR1cm4gdW5kZWZpbmVkO1xufTtcblxuQmFzZU1vZGVsLnByb3RvdHlwZS52YWxpZGF0ZSA9IGZ1bmN0aW9uIGYocHJvcGVydHlOYW1lLCB2YWx1ZSkge1xuICB2YWx1ZSA9IHZhbHVlIHx8IHRoaXNbcHJvcGVydHlOYW1lXTtcbiAgdGhpcy5fdmFsaWRhdG9ycyA9IHRoaXMuX3ZhbGlkYXRvcnMgfHwge307XG4gIHJldHVybiBzY2hlbWVyLmdldF92YWxpZGF0aW9uX21lc3NhZ2UodGhpcy5fdmFsaWRhdG9yc1twcm9wZXJ0eU5hbWVdIHx8IFtdLCB2YWx1ZSk7XG59O1xuXG5CYXNlTW9kZWwucHJvdG90eXBlLnNhdmUgPSBmdW5jdGlvbiBmbihvcHRpb25zLCBjYWxsYmFjaykge1xuICBpZiAoYXJndW1lbnRzLmxlbmd0aCA9PT0gMSAmJiB0eXBlb2Ygb3B0aW9ucyA9PT0gJ2Z1bmN0aW9uJykge1xuICAgIGNhbGxiYWNrID0gb3B0aW9ucztcbiAgICBvcHRpb25zID0ge307XG4gIH1cblxuICBjb25zdCBwcm9wZXJ0aWVzID0gdGhpcy5jb25zdHJ1Y3Rvci5fcHJvcGVydGllcztcbiAgY29uc3Qgc2NoZW1hID0gcHJvcGVydGllcy5zY2hlbWE7XG5cbiAgY29uc3QgZGVmYXVsdHMgPSB7XG4gICAgcHJlcGFyZTogdHJ1ZSxcbiAgfTtcblxuICBvcHRpb25zID0gXy5kZWZhdWx0c0RlZXAob3B0aW9ucywgZGVmYXVsdHMpO1xuXG4gIGlmICh0eXBlb2Ygc2NoZW1hLmJlZm9yZV9zYXZlID09PSAnZnVuY3Rpb24nICYmIHNjaGVtYS5iZWZvcmVfc2F2ZSh0aGlzLCBvcHRpb25zKSA9PT0gZmFsc2UpIHtcbiAgICBwYXJzZXIuY2FsbGJhY2tfb3JfdGhyb3coYnVpbGRFcnJvcignbW9kZWwuc2F2ZS5iZWZvcmUuZXJyb3InKSwgY2FsbGJhY2spO1xuICAgIHJldHVybiB7fTtcbiAgfVxuXG4gIGNvbnN0IHtcbiAgICBpZGVudGlmaWVycyxcbiAgICB2YWx1ZXMsXG4gICAgcXVlcnlQYXJhbXMsXG4gICAgZXJyb3JIYXBwZW5lZCxcbiAgfSA9IHBhcnNlci5nZXRfc2F2ZV92YWx1ZV9leHByZXNzaW9uKHRoaXMsIHNjaGVtYSwgY2FsbGJhY2spO1xuXG4gIGlmIChlcnJvckhhcHBlbmVkKSByZXR1cm4ge307XG5cbiAgbGV0IHF1ZXJ5ID0gdXRpbC5mb3JtYXQoXG4gICAgJ0lOU0VSVCBJTlRPIFwiJXNcIiAoICVzICkgVkFMVUVTICggJXMgKScsXG4gICAgcHJvcGVydGllcy50YWJsZV9uYW1lLFxuICAgIGlkZW50aWZpZXJzLmpvaW4oJyAsICcpLFxuICAgIHZhbHVlcy5qb2luKCcgLCAnKSxcbiAgKTtcblxuICBpZiAob3B0aW9ucy5pZl9ub3RfZXhpc3QpIHF1ZXJ5ICs9ICcgSUYgTk9UIEVYSVNUUyc7XG5cbiAgbGV0IGZpbmFsUGFyYW1zID0gcXVlcnlQYXJhbXM7XG4gIGlmIChfLmlzTnVtYmVyKG9wdGlvbnMudHRsKSkge1xuICAgIHF1ZXJ5ICs9ICcgVVNJTkcgVFRMID8nO1xuICAgIGZpbmFsUGFyYW1zID0gZmluYWxQYXJhbXMuY29uY2F0KFtvcHRpb25zLnR0bF0pO1xuICB9XG5cbiAgcXVlcnkgKz0gJzsnO1xuXG4gIGlmIChvcHRpb25zLnJldHVybl9xdWVyeSkge1xuICAgIGNvbnN0IHJldHVybk9iaiA9IHtcbiAgICAgIHF1ZXJ5LFxuICAgICAgcGFyYW1zOiBmaW5hbFBhcmFtcyxcbiAgICAgIGFmdGVyX2hvb2s6ICgpID0+IHtcbiAgICAgICAgaWYgKHR5cGVvZiBzY2hlbWEuYWZ0ZXJfc2F2ZSA9PT0gJ2Z1bmN0aW9uJyAmJiBzY2hlbWEuYWZ0ZXJfc2F2ZSh0aGlzLCBvcHRpb25zKSA9PT0gZmFsc2UpIHtcbiAgICAgICAgICByZXR1cm4gYnVpbGRFcnJvcignbW9kZWwuc2F2ZS5hZnRlci5lcnJvcicpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfSxcbiAgICB9O1xuICAgIHJldHVybiByZXR1cm5PYmo7XG4gIH1cblxuICBjb25zdCBxdWVyeU9wdGlvbnMgPSBub3JtYWxpemVyLm5vcm1hbGl6ZV9xdWVyeV9vcHRpb24ob3B0aW9ucyk7XG5cbiAgdGhpcy5jb25zdHJ1Y3Rvci5fZXhlY3V0ZV90YWJsZV9xdWVyeShxdWVyeSwgZmluYWxQYXJhbXMsIHF1ZXJ5T3B0aW9ucywgKGVyciwgcmVzdWx0KSA9PiB7XG4gICAgaWYgKHR5cGVvZiBjYWxsYmFjayA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgaWYgKGVycikge1xuICAgICAgICBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC5zYXZlLmRiZXJyb3InLCBlcnIpKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgaWYgKCFvcHRpb25zLmlmX25vdF9leGlzdCB8fCAocmVzdWx0LnJvd3MgJiYgcmVzdWx0LnJvd3NbMF0gJiYgcmVzdWx0LnJvd3NbMF1bJ1thcHBsaWVkXSddKSkge1xuICAgICAgICB0aGlzLl9tb2RpZmllZCA9IHt9O1xuICAgICAgfVxuICAgICAgaWYgKHR5cGVvZiBzY2hlbWEuYWZ0ZXJfc2F2ZSA9PT0gJ2Z1bmN0aW9uJyAmJiBzY2hlbWEuYWZ0ZXJfc2F2ZSh0aGlzLCBvcHRpb25zKSA9PT0gZmFsc2UpIHtcbiAgICAgICAgY2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwuc2F2ZS5hZnRlci5lcnJvcicpKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2FsbGJhY2sobnVsbCwgcmVzdWx0KTtcbiAgICB9IGVsc2UgaWYgKGVycikge1xuICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLnNhdmUuZGJlcnJvcicsIGVycikpO1xuICAgIH0gZWxzZSBpZiAodHlwZW9mIHNjaGVtYS5hZnRlcl9zYXZlID09PSAnZnVuY3Rpb24nICYmIHNjaGVtYS5hZnRlcl9zYXZlKHRoaXMsIG9wdGlvbnMpID09PSBmYWxzZSkge1xuICAgICAgdGhyb3cgKGJ1aWxkRXJyb3IoJ21vZGVsLnNhdmUuYWZ0ZXIuZXJyb3InKSk7XG4gICAgfVxuICB9KTtcblxuICByZXR1cm4ge307XG59O1xuXG5CYXNlTW9kZWwucHJvdG90eXBlLmRlbGV0ZSA9IGZ1bmN0aW9uIGYob3B0aW9ucywgY2FsbGJhY2spIHtcbiAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPT09IDEgJiYgdHlwZW9mIG9wdGlvbnMgPT09ICdmdW5jdGlvbicpIHtcbiAgICBjYWxsYmFjayA9IG9wdGlvbnM7XG4gICAgb3B0aW9ucyA9IHt9O1xuICB9XG5cbiAgY29uc3Qgc2NoZW1hID0gdGhpcy5jb25zdHJ1Y3Rvci5fcHJvcGVydGllcy5zY2hlbWE7XG4gIGNvbnN0IGRlbGV0ZVF1ZXJ5ID0ge307XG5cbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBzY2hlbWEua2V5Lmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgZmllbGRLZXkgPSBzY2hlbWEua2V5W2ldO1xuICAgIGlmIChfLmlzQXJyYXkoZmllbGRLZXkpKSB7XG4gICAgICBmb3IgKGxldCBqID0gMDsgaiA8IGZpZWxkS2V5Lmxlbmd0aDsgaisrKSB7XG4gICAgICAgIGRlbGV0ZVF1ZXJ5W2ZpZWxkS2V5W2pdXSA9IHRoaXNbZmllbGRLZXlbal1dO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICBkZWxldGVRdWVyeVtmaWVsZEtleV0gPSB0aGlzW2ZpZWxkS2V5XTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gdGhpcy5jb25zdHJ1Y3Rvci5kZWxldGUoZGVsZXRlUXVlcnksIG9wdGlvbnMsIGNhbGxiYWNrKTtcbn07XG5cbkJhc2VNb2RlbC5wcm90b3R5cGUudG9KU09OID0gZnVuY3Rpb24gdG9KU09OKCkge1xuICBjb25zdCBvYmplY3QgPSB7fTtcbiAgY29uc3Qgc2NoZW1hID0gdGhpcy5jb25zdHJ1Y3Rvci5fcHJvcGVydGllcy5zY2hlbWE7XG5cbiAgT2JqZWN0LmtleXMoc2NoZW1hLmZpZWxkcykuZm9yRWFjaCgoZmllbGQpID0+IHtcbiAgICBvYmplY3RbZmllbGRdID0gdGhpc1tmaWVsZF07XG4gIH0pO1xuXG4gIHJldHVybiBvYmplY3Q7XG59O1xuXG5CYXNlTW9kZWwucHJvdG90eXBlLmlzTW9kaWZpZWQgPSBmdW5jdGlvbiBpc01vZGlmaWVkKHByb3BOYW1lKSB7XG4gIGlmIChwcm9wTmFtZSkge1xuICAgIHJldHVybiBPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwodGhpcy5fbW9kaWZpZWQsIHByb3BOYW1lKTtcbiAgfVxuICByZXR1cm4gT2JqZWN0LmtleXModGhpcy5fbW9kaWZpZWQpLmxlbmd0aCAhPT0gMDtcbn07XG5cbm1vZHVsZS5leHBvcnRzID0gQmFzZU1vZGVsO1xuIl19