'use strict';

var _ = require('lodash');
var async = require('async');
var util = require('util');
var objectHash = require('object-hash');
var readlineSync = require('readline-sync');
var deepDiff = require('deep-diff').diff;

var buildError = require('../orm/apollo_error.js');
var schemer = require('../validators/schema');
var parser = require('../utils/parser');
var normalizer = require('../utils/normalizer');

var ElassandraBuilder = require('./elassandra');

var TableBuilder = function f(driver, properties) {
  this._driver = driver;
  this._properties = properties;
  if (this._properties.esclient) {
    this._es_builder = new ElassandraBuilder(this._properties.esclient);
  }
};

TableBuilder.prototype = {
  _confirm_migration(message) {
    var permission = 'y';
    if (message && !this._properties.disableTTYConfirmation) {
      permission = readlineSync.question(util.format('Migration: %s (y/n): ', message));
    }
    return permission.toLowerCase();
  },
  get_table(callback) {
    var properties = this._properties;
    var keyspaceName = properties.keyspace;
    var tableName = properties.table_name;
    var dbSchema = { fields: {}, typeMaps: {}, staticMaps: {} };
    var query = 'SELECT * FROM system_schema.columns WHERE table_name = ? AND keyspace_name = ?;';

    this._driver.execute_query(query, [tableName, keyspaceName], function (err, resultColumns) {
      if (err) {
        callback(buildError('model.tablecreation.dbschemaquery', err));
        return;
      }

      if (!resultColumns.rows || resultColumns.rows.length === 0) {
        callback();
        return;
      }

      for (var r = 0; r < resultColumns.rows.length; r++) {
        var row = resultColumns.rows[r];

        dbSchema.fields[row.column_name] = parser.extract_type(row.type);

        var typeMapDef = parser.extract_typeDef(row.type);
        if (typeMapDef.length > 0) {
          dbSchema.typeMaps[row.column_name] = typeMapDef;
        }

        if (row.kind === 'partition_key') {
          if (!dbSchema.key) dbSchema.key = [[]];
          dbSchema.key[0][row.position] = row.column_name;
        } else if (row.kind === 'clustering') {
          if (!dbSchema.key) dbSchema.key = [[]];
          if (!dbSchema.clustering_order) dbSchema.clustering_order = {};

          dbSchema.key[row.position + 1] = row.column_name;
          if (row.clustering_order && row.clustering_order.toLowerCase() === 'desc') {
            dbSchema.clustering_order[row.column_name] = 'DESC';
          } else {
            dbSchema.clustering_order[row.column_name] = 'ASC';
          }
        } else if (row.kind === 'static') {
          dbSchema.staticMaps[row.column_name] = true;
        }
      }

      callback(null, dbSchema);
    });
  },

  get_table_schema(callback) {
    var _this = this;

    this.get_table(function (err, dbSchema) {
      if (err) {
        callback(err);
        return;
      }
      if (!dbSchema) {
        callback();
        return;
      }
      _this.get_indexes(function (err1, indexSchema) {
        if (err1) {
          callback(err1);
          return;
        }
        _this.get_mviews(function (err2, viewSchema) {
          if (err2) {
            callback(err2);
            return;
          }
          Object.assign(dbSchema, indexSchema, viewSchema);
          callback(null, dbSchema);
        });
      });
    });
  },

  create_table(schema, callback) {
    var properties = this._properties;
    var tableName = properties.table_name;
    var rows = [];
    var fieldType = void 0;
    Object.keys(schema.fields).forEach(function (k) {
      if (schema.fields[k].virtual) {
        return;
      }
      var segment = '';
      fieldType = schemer.get_field_type(schema, k);
      if (schema.fields[k].typeDef) {
        segment = util.format('"%s" %s%s', k, fieldType, schema.fields[k].typeDef);
      } else {
        segment = util.format('"%s" %s', k, fieldType);
      }

      if (schema.fields[k].static) {
        segment += ' STATIC';
      }

      rows.push(segment);
    });

    var clauses = parser.get_primary_key_clauses(schema);

    var query = util.format('CREATE TABLE IF NOT EXISTS "%s" (%s , PRIMARY KEY((%s)%s))%s;', tableName, rows.join(' , '), clauses.partitionKeyClause, clauses.clusteringKeyClause, clauses.clusteringOrderClause);

    this._driver.execute_definition_query(query, function (err, result) {
      if (err) {
        callback(buildError('model.tablecreation.dbcreate', err));
        return;
      }
      callback(null, result);
    });
  },

  alter_table(operation, fieldname, type, callback) {
    var properties = this._properties;
    var tableName = properties.table_name;
    if (operation === 'ALTER') type = util.format('TYPE %s', type);else if (operation === 'DROP') type = '';

    var query = util.format('ALTER TABLE "%s" %s "%s" %s;', tableName, operation, fieldname, type);
    this._driver.execute_definition_query(query, callback);
  },

  _drop_table(tableName, callback) {
    var query = util.format('DROP TABLE IF EXISTS "%s";', tableName);
    this._driver.execute_definition_query(query, function (err) {
      if (err) {
        callback(buildError('model.tablecreation.dbdrop', err));
        return;
      }
      callback();
    });
  },

  drop_table(materializedViews, callback) {
    var _this2 = this;

    var properties = this._properties;
    var tableName = properties.table_name;
    var message = util.format('Schema for table "%s" has changed in a way where alter migration is not possible, all data in the table will be lost, are you sure you want to drop the table?', tableName);
    var permission = this._confirm_migration(message);
    if (permission !== 'y') {
      callback(buildError('model.tablecreation.schemamismatch', tableName, 'migration suspended, please apply the change manually'));
      return;
    }
    if (!materializedViews) {
      this._drop_table(tableName, callback);
      return;
    }

    var mviews = Object.keys(materializedViews);
    this.drop_mviews(mviews, function (err) {
      if (err) {
        callback(err);
        return;
      }

      _this2._drop_table(tableName, callback);
    });
  },

  drop_recreate_table(modelSchema, materializedViews, callback) {
    var _this3 = this;

    if (this._es_builder) {
      var indexName = `${this._properties.keyspace}_${this._properties.table_name}`;
      this._es_builder.delete_index(indexName, function () {
        _this3.drop_table(materializedViews, function (err1) {
          if (err1) {
            callback(err1);
            return;
          }
          _this3.create_table(modelSchema, callback);
        });
      });
      return;
    }
    this.drop_table(materializedViews, function (err1) {
      if (err1) {
        callback(err1);
        return;
      }
      _this3.create_table(modelSchema, callback);
    });
  },

  get_indexes(callback) {
    var properties = this._properties;
    var keyspaceName = properties.keyspace;
    var tableName = properties.table_name;
    var dbSchema = {};
    var query = 'SELECT * FROM system_schema.indexes WHERE table_name = ? AND keyspace_name = ?;';

    this._driver.execute_query(query, [tableName, keyspaceName], function (err, resultIndexes) {
      if (err) {
        callback(buildError('model.tablecreation.dbschemaquery', err));
        return;
      }

      for (var r = 0; r < resultIndexes.rows.length; r++) {
        var row = resultIndexes.rows[r];

        if (row.index_name && row.options.target) {
          var indexOptions = row.options;
          var target = indexOptions.target;
          target = target.replace(/["\s]/g, '');
          delete indexOptions.target;

          // keeping track of index names to drop index when needed
          if (!dbSchema.index_names) dbSchema.index_names = {};

          if (row.kind === 'CUSTOM') {
            var using = indexOptions.class_name;
            delete indexOptions.class_name;

            if (!dbSchema.custom_indexes) dbSchema.custom_indexes = [];
            var customIndexObject = {
              on: target,
              using,
              options: indexOptions
            };
            dbSchema.custom_indexes.push(customIndexObject);
            dbSchema.index_names[objectHash(customIndexObject)] = row.index_name;
          } else {
            if (!dbSchema.indexes) dbSchema.indexes = [];
            dbSchema.indexes.push(target);
            dbSchema.index_names[target] = row.index_name;
          }
        }
      }

      callback(null, dbSchema);
    });
  },

  _create_index_query(tableName, indexName) {
    var query = void 0;
    var indexExpression = indexName.replace(/["\s]/g, '').split(/[()]/g);
    if (indexExpression.length > 1) {
      indexExpression[0] = indexExpression[0].toLowerCase();
      query = util.format('CREATE INDEX IF NOT EXISTS ON "%s" (%s("%s"));', tableName, indexExpression[0], indexExpression[1]);
    } else {
      query = util.format('CREATE INDEX IF NOT EXISTS ON "%s" ("%s");', tableName, indexExpression[0]);
    }
    return query;
  },

  create_indexes(indexes, callback) {
    var _this4 = this;

    var properties = this._properties;
    var tableName = properties.table_name;
    async.eachSeries(indexes, function (idx, next) {
      var query = _this4._create_index_query(tableName, idx);
      _this4._driver.execute_definition_query(query, function (err, result) {
        if (err) next(buildError('model.tablecreation.dbindexcreate', err));else next(null, result);
      });
    }, callback);
  },

  _create_custom_index_query(tableName, customIndex) {
    var query = util.format('CREATE CUSTOM INDEX IF NOT EXISTS ON "%s" ("%s") USING \'%s\'', tableName, customIndex.on, customIndex.using);

    if (Object.keys(customIndex.options).length > 0) {
      query += ' WITH OPTIONS = {';
      Object.keys(customIndex.options).forEach(function (key) {
        query += util.format("'%s': '%s', ", key, customIndex.options[key]);
      });
      query = query.slice(0, -2);
      query += '}';
    }

    query += ';';

    return query;
  },

  create_custom_indexes(customIndexes, callback) {
    var _this5 = this;

    var properties = this._properties;
    var tableName = properties.table_name;
    async.eachSeries(customIndexes, function (idx, next) {
      var query = _this5._create_custom_index_query(tableName, idx);
      _this5._driver.execute_definition_query(query, function (err, result) {
        if (err) next(buildError('model.tablecreation.dbindexcreate', err));else next(null, result);
      });
    }, callback);
  },

  drop_indexes(indexes, callback) {
    var _this6 = this;

    async.each(indexes, function (idx, next) {
      var query = util.format('DROP INDEX IF EXISTS "%s";', idx);
      _this6._driver.execute_definition_query(query, next);
    }, function (err) {
      if (err) callback(buildError('model.tablecreation.dbindexdrop', err));else callback();
    });
  },

  get_mviews(callback) {
    var _this7 = this;

    var properties = this._properties;
    var keyspaceName = properties.keyspace;
    var tableName = properties.table_name;
    var dbSchema = {};
    var query = 'SELECT view_name,base_table_name,where_clause FROM system_schema.views WHERE keyspace_name=? AND base_table_name=? ALLOW FILTERING;';

    this._driver.execute_query(query, [keyspaceName, tableName], function (err, resultViews) {
      if (err) {
        callback(buildError('model.tablecreation.dbschemaquery', err));
        return;
      }

      for (var r = 0; r < resultViews.rows.length; r++) {
        var row = resultViews.rows[r];

        if (row.view_name) {
          if (!dbSchema.materialized_views) dbSchema.materialized_views = {};
          dbSchema.materialized_views[row.view_name] = {
            where_clause: row.where_clause
          };
        }
      }

      if (!dbSchema.materialized_views) {
        callback(null, dbSchema);
        return;
      }

      query = 'SELECT * FROM system_schema.columns WHERE keyspace_name=? and table_name IN ?;';

      var viewNames = Object.keys(dbSchema.materialized_views);
      _this7._driver.execute_query(query, [keyspaceName, viewNames], function (err1, resultMatViews) {
        if (err1) {
          callback(buildError('model.tablecreation.dbschemaquery', err1));
          return;
        }

        for (var _r = 0; _r < resultMatViews.rows.length; _r++) {
          var _row = resultMatViews.rows[_r];

          if (!dbSchema.materialized_views[_row.table_name].select) {
            dbSchema.materialized_views[_row.table_name].select = [];
          }

          dbSchema.materialized_views[_row.table_name].select.push(_row.column_name);

          if (_row.kind === 'partition_key') {
            if (!dbSchema.materialized_views[_row.table_name].key) {
              dbSchema.materialized_views[_row.table_name].key = [[]];
            }

            dbSchema.materialized_views[_row.table_name].key[0][_row.position] = _row.column_name;
          } else if (_row.kind === 'clustering') {
            if (!dbSchema.materialized_views[_row.table_name].key) {
              dbSchema.materialized_views[_row.table_name].key = [[]];
            }
            if (!dbSchema.materialized_views[_row.table_name].clustering_order) {
              dbSchema.materialized_views[_row.table_name].clustering_order = {};
            }

            dbSchema.materialized_views[_row.table_name].key[_row.position + 1] = _row.column_name;
            if (_row.clustering_order && _row.clustering_order.toLowerCase() === 'desc') {
              dbSchema.materialized_views[_row.table_name].clustering_order[_row.column_name] = 'DESC';
            } else {
              dbSchema.materialized_views[_row.table_name].clustering_order[_row.column_name] = 'ASC';
            }
          }
        }

        callback(null, dbSchema);
      });
    });
  },

  _create_materialized_view_query(tableName, viewName, viewSchema) {
    var rows = [];

    for (var k = 0; k < viewSchema.select.length; k++) {
      if (viewSchema.select[k] === '*') rows.push(util.format('%s', viewSchema.select[k]));else rows.push(util.format('"%s"', viewSchema.select[k]));
    }

    var whereClause = viewSchema.where_clause || parser.get_mview_where_clause(this._properties.schema, viewSchema);
    var clauses = parser.get_primary_key_clauses(viewSchema);

    var query = util.format('CREATE MATERIALIZED VIEW IF NOT EXISTS "%s" AS SELECT %s FROM "%s" WHERE %s PRIMARY KEY((%s)%s)%s;', viewName, rows.join(' , '), tableName, whereClause, clauses.partitionKeyClause, clauses.clusteringKeyClause, clauses.clusteringOrderClause);

    return query;
  },

  create_mviews(materializedViews, callback) {
    var _this8 = this;

    var properties = this._properties;
    var tableName = properties.table_name;
    async.eachSeries(Object.keys(materializedViews), function (viewName, next) {
      var query = _this8._create_materialized_view_query(tableName, viewName, materializedViews[viewName]);
      _this8._driver.execute_definition_query(query, function (err, result) {
        if (err) next(buildError('model.tablecreation.matviewcreate', err));else next(null, result);
      });
    }, callback);
  },

  drop_mviews(mviews, callback) {
    var _this9 = this;

    async.each(mviews, function (view, next) {
      var query = util.format('DROP MATERIALIZED VIEW IF EXISTS "%s";', view);
      _this9._driver.execute_definition_query(query, next);
    }, function (err) {
      if (err) callback(buildError('model.tablecreation.matviewdrop', err));else callback();
    });
  },

  _apply_alter_operations(alterOperations, dbSchema, normalizedModelSchema, normalizedDBSchema, callback) {
    var _this10 = this;

    // it should create/drop indexes/custom_indexes/materialized_views that are added/removed in model schema
    // remove common indexes/custom_indexes/materialized_views from normalizedModelSchema and normalizedDBSchema
    // then drop all remaining indexes/custom_indexes/materialized_views from normalizedDBSchema
    // and add all remaining indexes/custom_indexes/materialized_views from normalizedModelSchema
    var properties = this._properties;
    var tableName = properties.table_name;
    var addedIndexes = _.difference(normalizedModelSchema.indexes, normalizedDBSchema.indexes);
    var removedIndexes = _.difference(normalizedDBSchema.indexes, normalizedModelSchema.indexes);
    var removedIndexNames = [];
    removedIndexes.forEach(function (removedIndex) {
      removedIndexNames.push(dbSchema.index_names[removedIndex]);
    });

    var addedCustomIndexes = _.filter(normalizedModelSchema.custom_indexes, function (obj) {
      return !_.find(normalizedDBSchema.custom_indexes, obj);
    });
    var removedCustomIndexes = _.filter(normalizedDBSchema.custom_indexes, function (obj) {
      return !_.find(normalizedModelSchema.custom_indexes, obj);
    });
    removedCustomIndexes.forEach(function (removedIndex) {
      removedIndexNames.push(dbSchema.index_names[objectHash(removedIndex)]);
    });

    var addedMaterializedViewsNames = _.filter(Object.keys(normalizedModelSchema.materialized_views), function (viewName) {
      return !_.isEqual(normalizedDBSchema.materialized_views[viewName], normalizedModelSchema.materialized_views[viewName]);
    });

    var removedMaterializedViewNames = _.filter(Object.keys(normalizedDBSchema.materialized_views), function (viewName) {
      return !_.isEqual(normalizedDBSchema.materialized_views[viewName], normalizedModelSchema.materialized_views[viewName]);
    });

    var addedMaterializedViews = {};
    addedMaterializedViewsNames.forEach(function (viewName) {
      addedMaterializedViews[viewName] = normalizedModelSchema.materialized_views[viewName];
    });

    // remove altered materialized views
    if (removedMaterializedViewNames.length > 0) {
      var message = util.format('Schema for table "%s" has removed materialized_views: %j, are you sure you want to drop them?', tableName, removedMaterializedViewNames);
      var permission = this._confirm_migration(message);
      if (permission !== 'y') {
        callback(buildError('model.tablecreation.schemamismatch', tableName, 'migration suspended, please apply the change manually'));
        return;
      }
    }

    this.drop_mviews(removedMaterializedViewNames, function (err2) {
      if (err2) {
        callback(err2);
        return;
      }

      if (removedIndexNames.length > 0) {
        var _message = util.format('Schema for table "%s" has removed indexes: %j, are you sure you want to drop them?', tableName, removedIndexNames);
        var _permission = _this10._confirm_migration(_message);
        if (_permission !== 'y') {
          callback(buildError('model.tablecreation.schemamismatch', tableName, 'migration suspended, please apply the change manually'));
          return;
        }
      }

      // remove altered indexes by index name
      _this10.drop_indexes(removedIndexNames, function (err3) {
        if (err3) {
          callback(err3);
          return;
        }

        // now apply alterOperations here
        async.eachSeries(alterOperations, function (alterOperation, next) {
          var permission = _this10._confirm_migration(alterOperation.message);
          if (permission !== 'y') {
            callback(buildError('model.tablecreation.schemamismatch', tableName, 'migration suspended, please apply the change manually'));
            return;
          }
          _this10.alter_table(alterOperation.operation, alterOperation.fieldName, alterOperation.type, next);
        }, function (err4) {
          if (err4) {
            callback(err4);
            return;
          }

          // add altered indexes
          // eslint-disable-next-line max-nested-callbacks
          _this10.create_indexes(addedIndexes, function (err5) {
            if (err5) {
              callback(err5);
              return;
            }

            // add altered custom indexes
            // eslint-disable-next-line max-nested-callbacks
            _this10.create_custom_indexes(addedCustomIndexes, function (err6) {
              if (err6) {
                callback(err6);
                return;
              }

              // add altered materialized_views
              _this10.create_mviews(addedMaterializedViews, callback);
            });
          });
        });
      });
    });
  },

  init_alter_operations(modelSchema, dbSchema, normalizedModelSchema, normalizedDBSchema, callback) {
    var _this11 = this;

    var properties = this._properties;
    var tableName = properties.table_name;
    var alterOperations = [];
    var differences = deepDiff(normalizedDBSchema.fields, normalizedModelSchema.fields);
    var droppedFields = false;
    async.eachSeries(differences, function (diff, next) {
      var fieldName = diff.path[0];
      if (diff.kind === 'N') {
        var message = util.format('Schema for table "%s" has added field "%s", are you sure you want to alter to add the field?', tableName, fieldName);
        alterOperations.push({
          fieldName,
          message,
          operation: 'ADD',
          type: parser.extract_altered_type(normalizedModelSchema, diff)
        });
        next();
        return;
      }
      if (diff.kind === 'D') {
        var _message2 = util.format('Schema for table "%s" has removed field "%s", all data in the field will lost, are you sure you want to alter to drop the field?', tableName, fieldName);
        alterOperations.push({
          fieldName,
          message: _message2,
          operation: 'DROP'
        });
        droppedFields = true;
        normalizer.remove_dependent_views_from_normalized_schema(normalizedDBSchema, dbSchema, fieldName);
        next();
        return;
      }
      if (diff.kind === 'E') {
        // check if the alter field type is possible, otherwise try D and then N
        if (diff.path[1] === 'type') {
          // check if field part of primary key
          if (normalizedDBSchema.key[0].includes(fieldName) || normalizedDBSchema.key.indexOf(fieldName) > 0) {
            // alter field type impossible
            next(new Error('alter_impossible'));
          } else if (['text', 'ascii', 'bigint', 'boolean', 'decimal', 'double', 'float', 'inet', 'int', 'timestamp', 'timeuuid', 'uuid', 'varchar', 'varint'].includes(diff.lhs) && diff.rhs === 'blob') {
            // alter field type possible
            var _message3 = util.format('Schema for table "%s" has new type for field "%s", are you sure you want to alter to update the field type?', tableName, fieldName);
            alterOperations.push({
              fieldName,
              message: _message3,
              operation: 'ALTER',
              type: diff.rhs
            });
            next();
          } else if (diff.lhs === 'int' && diff.rhs === 'varint') {
            // alter field type possible
            var _message4 = util.format('Schema for table "%s" has new type for field "%s", are you sure you want to alter to update the field type?', tableName, fieldName);
            alterOperations.push({
              fieldName,
              message: _message4,
              operation: 'ALTER',
              type: diff.rhs
            });
            next();
          } else if (diff.lhs === 'timeuuid' && diff.rhs === 'uuid') {
            // alter field type possible
            var _message5 = util.format('Schema for table "%s" has new type for field "%s", are you sure you want to alter to update the field type?', tableName, fieldName);
            alterOperations.push({
              fieldName,
              message: _message5,
              operation: 'ALTER',
              type: diff.rhs
            });
            next();
          } else {
            // alter type impossible
            var _message6 = util.format('Schema for table "%s" has new type for field "%s", all data in the field will be lost, are you sure you want to drop the field & recreate it?', tableName, fieldName);
            alterOperations.push({
              fieldName,
              message: _message6,
              operation: 'DROP'
            });
            alterOperations.push({
              fieldName,
              operation: 'ADD',
              type: parser.extract_altered_type(normalizedModelSchema, diff)
            });
            droppedFields = true;
            normalizer.remove_dependent_views_from_normalized_schema(normalizedDBSchema, dbSchema, fieldName);
            next();
          }
        } else {
          // alter type impossible
          var _message7 = util.format('Schema for table "%s" has new type for field "%s", all data in the field will be lost, are you sure you want to drop the field & recreate it?', tableName, fieldName);
          alterOperations.push({
            fieldName,
            message: _message7,
            operation: 'DROP'
          });
          alterOperations.push({
            fieldName,
            operation: 'ADD',
            type: parser.extract_altered_type(normalizedModelSchema, diff)
          });
          droppedFields = true;
          normalizer.remove_dependent_views_from_normalized_schema(normalizedDBSchema, dbSchema, fieldName);
          next();
        }
        return;
      }

      next();
    }, function (err) {
      if (err) {
        callback(err);
        return;
      }
      if (droppedFields && _this11._es_builder) {
        var indexName = `${properties.keyspace}_${properties.table_name}`;
        _this11._es_builder.delete_index(indexName, function () {
          _this11._apply_alter_operations(alterOperations, dbSchema, normalizedModelSchema, normalizedDBSchema, callback);
        });
        return;
      }
      _this11._apply_alter_operations(alterOperations, dbSchema, normalizedModelSchema, normalizedDBSchema, callback);
    });
  }
};

module.exports = TableBuilder;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9idWlsZGVycy90YWJsZS5qcyJdLCJuYW1lcyI6WyJfIiwicmVxdWlyZSIsImFzeW5jIiwidXRpbCIsIm9iamVjdEhhc2giLCJyZWFkbGluZVN5bmMiLCJkZWVwRGlmZiIsImRpZmYiLCJidWlsZEVycm9yIiwic2NoZW1lciIsInBhcnNlciIsIm5vcm1hbGl6ZXIiLCJFbGFzc2FuZHJhQnVpbGRlciIsIlRhYmxlQnVpbGRlciIsImYiLCJkcml2ZXIiLCJwcm9wZXJ0aWVzIiwiX2RyaXZlciIsIl9wcm9wZXJ0aWVzIiwiZXNjbGllbnQiLCJfZXNfYnVpbGRlciIsInByb3RvdHlwZSIsIl9jb25maXJtX21pZ3JhdGlvbiIsIm1lc3NhZ2UiLCJwZXJtaXNzaW9uIiwiZGlzYWJsZVRUWUNvbmZpcm1hdGlvbiIsInF1ZXN0aW9uIiwiZm9ybWF0IiwidG9Mb3dlckNhc2UiLCJnZXRfdGFibGUiLCJjYWxsYmFjayIsImtleXNwYWNlTmFtZSIsImtleXNwYWNlIiwidGFibGVOYW1lIiwidGFibGVfbmFtZSIsImRiU2NoZW1hIiwiZmllbGRzIiwidHlwZU1hcHMiLCJzdGF0aWNNYXBzIiwicXVlcnkiLCJleGVjdXRlX3F1ZXJ5IiwiZXJyIiwicmVzdWx0Q29sdW1ucyIsInJvd3MiLCJsZW5ndGgiLCJyIiwicm93IiwiY29sdW1uX25hbWUiLCJleHRyYWN0X3R5cGUiLCJ0eXBlIiwidHlwZU1hcERlZiIsImV4dHJhY3RfdHlwZURlZiIsImtpbmQiLCJrZXkiLCJwb3NpdGlvbiIsImNsdXN0ZXJpbmdfb3JkZXIiLCJnZXRfdGFibGVfc2NoZW1hIiwiZ2V0X2luZGV4ZXMiLCJlcnIxIiwiaW5kZXhTY2hlbWEiLCJnZXRfbXZpZXdzIiwiZXJyMiIsInZpZXdTY2hlbWEiLCJPYmplY3QiLCJhc3NpZ24iLCJjcmVhdGVfdGFibGUiLCJzY2hlbWEiLCJmaWVsZFR5cGUiLCJrZXlzIiwiZm9yRWFjaCIsImsiLCJ2aXJ0dWFsIiwic2VnbWVudCIsImdldF9maWVsZF90eXBlIiwidHlwZURlZiIsInN0YXRpYyIsInB1c2giLCJjbGF1c2VzIiwiZ2V0X3ByaW1hcnlfa2V5X2NsYXVzZXMiLCJqb2luIiwicGFydGl0aW9uS2V5Q2xhdXNlIiwiY2x1c3RlcmluZ0tleUNsYXVzZSIsImNsdXN0ZXJpbmdPcmRlckNsYXVzZSIsImV4ZWN1dGVfZGVmaW5pdGlvbl9xdWVyeSIsInJlc3VsdCIsImFsdGVyX3RhYmxlIiwib3BlcmF0aW9uIiwiZmllbGRuYW1lIiwiX2Ryb3BfdGFibGUiLCJkcm9wX3RhYmxlIiwibWF0ZXJpYWxpemVkVmlld3MiLCJtdmlld3MiLCJkcm9wX212aWV3cyIsImRyb3BfcmVjcmVhdGVfdGFibGUiLCJtb2RlbFNjaGVtYSIsImluZGV4TmFtZSIsImRlbGV0ZV9pbmRleCIsInJlc3VsdEluZGV4ZXMiLCJpbmRleF9uYW1lIiwib3B0aW9ucyIsInRhcmdldCIsImluZGV4T3B0aW9ucyIsInJlcGxhY2UiLCJpbmRleF9uYW1lcyIsInVzaW5nIiwiY2xhc3NfbmFtZSIsImN1c3RvbV9pbmRleGVzIiwiY3VzdG9tSW5kZXhPYmplY3QiLCJvbiIsImluZGV4ZXMiLCJfY3JlYXRlX2luZGV4X3F1ZXJ5IiwiaW5kZXhFeHByZXNzaW9uIiwic3BsaXQiLCJjcmVhdGVfaW5kZXhlcyIsImVhY2hTZXJpZXMiLCJpZHgiLCJuZXh0IiwiX2NyZWF0ZV9jdXN0b21faW5kZXhfcXVlcnkiLCJjdXN0b21JbmRleCIsInNsaWNlIiwiY3JlYXRlX2N1c3RvbV9pbmRleGVzIiwiY3VzdG9tSW5kZXhlcyIsImRyb3BfaW5kZXhlcyIsImVhY2giLCJyZXN1bHRWaWV3cyIsInZpZXdfbmFtZSIsIm1hdGVyaWFsaXplZF92aWV3cyIsIndoZXJlX2NsYXVzZSIsInZpZXdOYW1lcyIsInJlc3VsdE1hdFZpZXdzIiwic2VsZWN0IiwiX2NyZWF0ZV9tYXRlcmlhbGl6ZWRfdmlld19xdWVyeSIsInZpZXdOYW1lIiwid2hlcmVDbGF1c2UiLCJnZXRfbXZpZXdfd2hlcmVfY2xhdXNlIiwiY3JlYXRlX212aWV3cyIsInZpZXciLCJfYXBwbHlfYWx0ZXJfb3BlcmF0aW9ucyIsImFsdGVyT3BlcmF0aW9ucyIsIm5vcm1hbGl6ZWRNb2RlbFNjaGVtYSIsIm5vcm1hbGl6ZWREQlNjaGVtYSIsImFkZGVkSW5kZXhlcyIsImRpZmZlcmVuY2UiLCJyZW1vdmVkSW5kZXhlcyIsInJlbW92ZWRJbmRleE5hbWVzIiwicmVtb3ZlZEluZGV4IiwiYWRkZWRDdXN0b21JbmRleGVzIiwiZmlsdGVyIiwib2JqIiwiZmluZCIsInJlbW92ZWRDdXN0b21JbmRleGVzIiwiYWRkZWRNYXRlcmlhbGl6ZWRWaWV3c05hbWVzIiwiaXNFcXVhbCIsInJlbW92ZWRNYXRlcmlhbGl6ZWRWaWV3TmFtZXMiLCJhZGRlZE1hdGVyaWFsaXplZFZpZXdzIiwiZXJyMyIsImFsdGVyT3BlcmF0aW9uIiwiZmllbGROYW1lIiwiZXJyNCIsImVycjUiLCJlcnI2IiwiaW5pdF9hbHRlcl9vcGVyYXRpb25zIiwiZGlmZmVyZW5jZXMiLCJkcm9wcGVkRmllbGRzIiwicGF0aCIsImV4dHJhY3RfYWx0ZXJlZF90eXBlIiwicmVtb3ZlX2RlcGVuZGVudF92aWV3c19mcm9tX25vcm1hbGl6ZWRfc2NoZW1hIiwiaW5jbHVkZXMiLCJpbmRleE9mIiwiRXJyb3IiLCJsaHMiLCJyaHMiLCJtb2R1bGUiLCJleHBvcnRzIl0sIm1hcHBpbmdzIjoiOztBQUFBLElBQU1BLElBQUlDLFFBQVEsUUFBUixDQUFWO0FBQ0EsSUFBTUMsUUFBUUQsUUFBUSxPQUFSLENBQWQ7QUFDQSxJQUFNRSxPQUFPRixRQUFRLE1BQVIsQ0FBYjtBQUNBLElBQU1HLGFBQWFILFFBQVEsYUFBUixDQUFuQjtBQUNBLElBQU1JLGVBQWVKLFFBQVEsZUFBUixDQUFyQjtBQUNBLElBQU1LLFdBQVdMLFFBQVEsV0FBUixFQUFxQk0sSUFBdEM7O0FBRUEsSUFBTUMsYUFBYVAsUUFBUSx3QkFBUixDQUFuQjtBQUNBLElBQU1RLFVBQVVSLFFBQVEsc0JBQVIsQ0FBaEI7QUFDQSxJQUFNUyxT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RS9FLFdBQVdnQixRQUFTLElBQUdoQixXQUFXa0IsVUFBVyxFQUFsRTtBQUNBLGdCQUFLZCxXQUFMLENBQWlCNEUsWUFBakIsQ0FBOEJELFNBQTlCLEVBQXlDLFlBQU07QUFDN0Msa0JBQUswQyx1QkFBTCxDQUE2QkMsZUFBN0IsRUFBOEN2RyxRQUE5QyxFQUF3RHdHLHFCQUF4RCxFQUErRUMsa0JBQS9FLEVBQW1HOUcsUUFBbkc7QUFDRCxTQUZEO0FBR0E7QUFDRDtBQUNELGNBQUsyRyx1QkFBTCxDQUE2QkMsZUFBN0IsRUFBOEN2RyxRQUE5QyxFQUF3RHdHLHFCQUF4RCxFQUErRUMsa0JBQS9FLEVBQW1HOUcsUUFBbkc7QUFDRCxLQS9JRDtBQWdKRDtBQXp0QnNCLENBQXpCOztBQTR0QkE4SSxPQUFPQyxPQUFQLEdBQWlCaEssWUFBakIiLCJmaWxlIjoidGFibGUuanMiLCJzb3VyY2VzQ29udGVudCI6WyJjb25zdCBfID0gcmVxdWlyZSgnbG9kYXNoJyk7XG5jb25zdCBhc3luYyA9IHJlcXVpcmUoJ2FzeW5jJyk7XG5jb25zdCB1dGlsID0gcmVxdWlyZSgndXRpbCcpO1xuY29uc3Qgb2JqZWN0SGFzaCA9IHJlcXVpcmUoJ29iamVjdC1oYXNoJyk7XG5jb25zdCByZWFkbGluZVN5bmMgPSByZXF1aXJlKCdyZWFkbGluZS1zeW5jJyk7XG5jb25zdCBkZWVwRGlmZiA9IHJlcXVpcmUoJ2RlZXAtZGlmZicpLmRpZmY7XG5cbmNvbnN0IGJ1aWxkRXJyb3IgPSByZXF1aXJlKCcuLi9vcm0vYXBvbGxvX2Vycm9yLmpzJyk7XG5jb25zdCBzY2hlbWVyID0gcmVxdWlyZSgnLi4vdmFsaWRhdG9ycy9zY2hlbWEnKTtcbmNvbnN0IHBhcnNlciA9IHJlcXVpcmUoJy4uL3V0aWxzL3BhcnNlcicpO1xuY29uc3Qgbm9ybWFsaXplciA9IHJlcXVpcmUoJy4uL3V0aWxzL25vcm1hbGl6ZXInKTtcblxuY29uc3QgRWxhc3NhbmRyYUJ1aWxkZXIgPSByZXF1aXJlKCcuL2VsYXNzYW5kcmEnKTtcblxuY29uc3QgVGFibGVCdWlsZGVyID0gZnVuY3Rpb24gZihkcml2ZXIsIHByb3BlcnRpZXMpIHtcbiAgdGhpcy5fZHJpdmVyID0gZHJpdmVyO1xuICB0aGlzLl9wcm9wZXJ0aWVzID0gcHJvcGVydGllcztcbiAgaWYgKHRoaXMuX3Byb3BlcnRpZXMuZXNjbGllbnQpIHtcbiAgICB0aGlzLl9lc19idWlsZGVyID0gbmV3IEVsYXNzYW5kcmFCdWlsZGVyKHRoaXMuX3Byb3BlcnRpZXMuZXNjbGllbnQpO1xuICB9XG59O1xuXG5UYWJsZUJ1aWxkZXIucHJvdG90eXBlID0ge1xuICBfY29uZmlybV9taWdyYXRpb24obWVzc2FnZSkge1xuICAgIGxldCBwZXJtaXNzaW9uID0gJ3knO1xuICAgIGlmIChtZXNzYWdlICYmICF0aGlzLl9wcm9wZXJ0aWVzLmRpc2FibGVUVFlDb25maXJtYXRpb24pIHtcbiAgICAgIHBlcm1pc3Npb24gPSByZWFkbGluZVN5bmMucXVlc3Rpb24odXRpbC5mb3JtYXQoJ01pZ3JhdGlvbjogJXMgKHkvbik6ICcsIG1lc3NhZ2UpKTtcbiAgICB9XG4gICAgcmV0dXJuIHBlcm1pc3Npb24udG9Mb3dlckNhc2UoKTtcbiAgfSxcbiAgZ2V0X3RhYmxlKGNhbGxiYWNrKSB7XG4gICAgY29uc3QgcHJvcGVydGllcyA9IHRoaXMuX3Byb3BlcnRpZXM7XG4gICAgY29uc3Qga2V5c3BhY2VOYW1lID0gcHJvcGVydGllcy5rZXlzcGFjZTtcbiAgICBjb25zdCB0YWJsZU5hbWUgPSBwcm9wZXJ0aWVzLnRhYmxlX25hbWU7XG4gICAgY29uc3QgZGJTY2hlbWEgPSB7IGZpZWxkczoge30sIHR5cGVNYXBzOiB7fSwgc3RhdGljTWFwczoge30gfTtcbiAgICBjb25zdCBxdWVyeSA9ICdTRUxFQ1QgKiBGUk9NIHN5c3RlbV9zY2hlbWEuY29sdW1ucyBXSEVSRSB0YWJsZV9uYW1lID0gPyBBTkQga2V5c3BhY2VfbmFtZSA9ID87JztcblxuICAgIHRoaXMuX2RyaXZlci5leGVjdXRlX3F1ZXJ5KHF1ZXJ5LCBbdGFibGVOYW1lLCBrZXlzcGFjZU5hbWVdLCAoZXJyLCByZXN1bHRDb2x1bW5zKSA9PiB7XG4gICAgICBpZiAoZXJyKSB7XG4gICAgICAgIGNhbGxiYWNrKGJ1aWxkRXJyb3IoJ21vZGVsLnRhYmxlY3JlYXRpb24uZGJzY2hlbWFxdWVyeScsIGVycikpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIGlmICghcmVzdWx0Q29sdW1ucy5yb3dzIHx8IHJlc3VsdENvbHVtbnMucm93cy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgY2FsbGJhY2soKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBmb3IgKGxldCByID0gMDsgciA8IHJlc3VsdENvbHVtbnMucm93cy5sZW5ndGg7IHIrKykge1xuICAgICAgICBjb25zdCByb3cgPSByZXN1bHRDb2x1bW5zLnJvd3Nbcl07XG5cbiAgICAgICAgZGJTY2hlbWEuZmllbGRzW3Jvdy5jb2x1bW5fbmFtZV0gPSBwYXJzZXIuZXh0cmFjdF90eXBlKHJvdy50eXBlKTtcblxuICAgICAgICBjb25zdCB0eXBlTWFwRGVmID0gcGFyc2VyLmV4dHJhY3RfdHlwZURlZihyb3cudHlwZSk7XG4gICAgICAgIGlmICh0eXBlTWFwRGVmLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICBkYlNjaGVtYS50eXBlTWFwc1tyb3cuY29sdW1uX25hbWVdID0gdHlwZU1hcERlZjtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChyb3cua2luZCA9PT0gJ3BhcnRpdGlvbl9rZXknKSB7XG4gICAgICAgICAgaWYgKCFkYlNjaGVtYS5rZXkpIGRiU2NoZW1hLmtleSA9IFtbXV07XG4gICAgICAgICAgZGJTY2hlbWEua2V5WzBdW3Jvdy5wb3NpdGlvbl0gPSByb3cuY29sdW1uX25hbWU7XG4gICAgICAgIH0gZWxzZSBpZiAocm93LmtpbmQgPT09ICdjbHVzdGVyaW5nJykge1xuICAgICAgICAgIGlmICghZGJTY2hlbWEua2V5KSBkYlNjaGVtYS5rZXkgPSBbW11dO1xuICAgICAgICAgIGlmICghZGJTY2hlbWEuY2x1c3RlcmluZ19vcmRlcikgZGJTY2hlbWEuY2x1c3RlcmluZ19vcmRlciA9IHt9O1xuXG4gICAgICAgICAgZGJTY2hlbWEua2V5W3Jvdy5wb3NpdGlvbiArIDFdID0gcm93LmNvbHVtbl9uYW1lO1xuICAgICAgICAgIGlmIChyb3cuY2x1c3RlcmluZ19vcmRlciAmJiByb3cuY2x1c3RlcmluZ19vcmRlci50b0xvd2VyQ2FzZSgpID09PSAnZGVzYycpIHtcbiAgICAgICAgICAgIGRiU2NoZW1hLmNsdXN0ZXJpbmdfb3JkZXJbcm93LmNvbHVtbl9uYW1lXSA9ICdERVNDJztcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgZGJTY2hlbWEuY2x1c3RlcmluZ19vcmRlcltyb3cuY29sdW1uX25hbWVdID0gJ0FTQyc7XG4gICAgICAgICAgfVxuICAgICAgICB9IGVsc2UgaWYgKHJvdy5raW5kID09PSAnc3RhdGljJykge1xuICAgICAgICAgIGRiU2NoZW1hLnN0YXRpY01hcHNbcm93LmNvbHVtbl9uYW1lXSA9IHRydWU7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgY2FsbGJhY2sobnVsbCwgZGJTY2hlbWEpO1xuICAgIH0pO1xuICB9LFxuXG4gIGdldF90YWJsZV9zY2hlbWEoY2FsbGJhY2spIHtcbiAgICB0aGlzLmdldF90YWJsZSgoZXJyLCBkYlNjaGVtYSkgPT4ge1xuICAgICAgaWYgKGVycikge1xuICAgICAgICBjYWxsYmFjayhlcnIpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBpZiAoIWRiU2NoZW1hKSB7XG4gICAgICAgIGNhbGxiYWNrKCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIHRoaXMuZ2V0X2luZGV4ZXMoKGVycjEsIGluZGV4U2NoZW1hKSA9PiB7XG4gICAgICAgIGlmIChlcnIxKSB7XG4gICAgICAgICAgY2FsbGJhY2soZXJyMSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIHRoaXMuZ2V0X212aWV3cygoZXJyMiwgdmlld1NjaGVtYSkgPT4ge1xuICAgICAgICAgIGlmIChlcnIyKSB7XG4gICAgICAgICAgICBjYWxsYmFjayhlcnIyKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9XG4gICAgICAgICAgT2JqZWN0LmFzc2lnbihkYlNjaGVtYSwgaW5kZXhTY2hlbWEsIHZpZXdTY2hlbWEpO1xuICAgICAgICAgIGNhbGxiYWNrKG51bGwsIGRiU2NoZW1hKTtcbiAgICAgICAgfSk7XG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSxcblxuICBjcmVhdGVfdGFibGUoc2NoZW1hLCBjYWxsYmFjaykge1xuICAgIGNvbnN0IHByb3BlcnRpZXMgPSB0aGlzLl9wcm9wZXJ0aWVzO1xuICAgIGNvbnN0IHRhYmxlTmFtZSA9IHByb3BlcnRpZXMudGFibGVfbmFtZTtcbiAgICBjb25zdCByb3dzID0gW107XG4gICAgbGV0IGZpZWxkVHlwZTtcbiAgICBPYmplY3Qua2V5cyhzY2hlbWEuZmllbGRzKS5mb3JFYWNoKChrKSA9PiB7XG4gICAgICBpZiAoc2NoZW1hLmZpZWxkc1trXS52aXJ0dWFsKSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGxldCBzZWdtZW50ID0gJyc7XG4gICAgICBmaWVsZFR5cGUgPSBzY2hlbWVyLmdldF9maWVsZF90eXBlKHNjaGVtYSwgayk7XG4gICAgICBpZiAoc2NoZW1hLmZpZWxkc1trXS50eXBlRGVmKSB7XG4gICAgICAgIHNlZ21lbnQgPSB1dGlsLmZvcm1hdCgnXCIlc1wiICVzJXMnLCBrLCBmaWVsZFR5cGUsIHNjaGVtYS5maWVsZHNba10udHlwZURlZik7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBzZWdtZW50ID0gdXRpbC5mb3JtYXQoJ1wiJXNcIiAlcycsIGssIGZpZWxkVHlwZSk7XG4gICAgICB9XG5cbiAgICAgIGlmIChzY2hlbWEuZmllbGRzW2tdLnN0YXRpYykge1xuICAgICAgICBzZWdtZW50ICs9ICcgU1RBVElDJztcbiAgICAgIH1cblxuICAgICAgcm93cy5wdXNoKHNlZ21lbnQpO1xuICAgIH0pO1xuXG4gICAgY29uc3QgY2xhdXNlcyA9IHBhcnNlci5nZXRfcHJpbWFyeV9rZXlfY2xhdXNlcyhzY2hlbWEpO1xuXG4gICAgY29uc3QgcXVlcnkgPSB1dGlsLmZvcm1hdChcbiAgICAgICdDUkVBVEUgVEFCTEUgSUYgTk9UIEVYSVNUUyBcIiVzXCIgKCVzICwgUFJJTUFSWSBLRVkoKCVzKSVzKSklczsnLFxuICAgICAgdGFibGVOYW1lLFxuICAgICAgcm93cy5qb2luKCcgLCAnKSxcbiAgICAgIGNsYXVzZXMucGFydGl0aW9uS2V5Q2xhdXNlLFxuICAgICAgY2xhdXNlcy5jbHVzdGVyaW5nS2V5Q2xhdXNlLFxuICAgICAgY2xhdXNlcy5jbHVzdGVyaW5nT3JkZXJDbGF1c2UsXG4gICAgKTtcblxuICAgIHRoaXMuX2RyaXZlci5leGVjdXRlX2RlZmluaXRpb25fcXVlcnkocXVlcnksIChlcnIsIHJlc3VsdCkgPT4ge1xuICAgICAgaWYgKGVycikge1xuICAgICAgICBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC50YWJsZWNyZWF0aW9uLmRiY3JlYXRlJywgZXJyKSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNhbGxiYWNrKG51bGwsIHJlc3VsdCk7XG4gICAgfSk7XG4gIH0sXG5cbiAgYWx0ZXJfdGFibGUob3BlcmF0aW9uLCBmaWVsZG5hbWUsIHR5cGUsIGNhbGxiYWNrKSB7XG4gICAgY29uc3QgcHJvcGVydGllcyA9IHRoaXMuX3Byb3BlcnRpZXM7XG4gICAgY29uc3QgdGFibGVOYW1lID0gcHJvcGVydGllcy50YWJsZV9uYW1lO1xuICAgIGlmIChvcGVyYXRpb24gPT09ICdBTFRFUicpIHR5cGUgPSB1dGlsLmZvcm1hdCgnVFlQRSAlcycsIHR5cGUpO1xuICAgIGVsc2UgaWYgKG9wZXJhdGlvbiA9PT0gJ0RST1AnKSB0eXBlID0gJyc7XG5cbiAgICBjb25zdCBxdWVyeSA9IHV0aWwuZm9ybWF0KCdBTFRFUiBUQUJMRSBcIiVzXCIgJXMgXCIlc1wiICVzOycsIHRhYmxlTmFtZSwgb3BlcmF0aW9uLCBmaWVsZG5hbWUsIHR5cGUpO1xuICAgIHRoaXMuX2RyaXZlci5leGVjdXRlX2RlZmluaXRpb25fcXVlcnkocXVlcnksIGNhbGxiYWNrKTtcbiAgfSxcblxuICBfZHJvcF90YWJsZSh0YWJsZU5hbWUsIGNhbGxiYWNrKSB7XG4gICAgY29uc3QgcXVlcnkgPSB1dGlsLmZvcm1hdCgnRFJPUCBUQUJMRSBJRiBFWElTVFMgXCIlc1wiOycsIHRhYmxlTmFtZSk7XG4gICAgdGhpcy5fZHJpdmVyLmV4ZWN1dGVfZGVmaW5pdGlvbl9xdWVyeShxdWVyeSwgKGVycikgPT4ge1xuICAgICAgaWYgKGVycikge1xuICAgICAgICBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC50YWJsZWNyZWF0aW9uLmRiZHJvcCcsIGVycikpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjYWxsYmFjaygpO1xuICAgIH0pO1xuICB9LFxuXG4gIGRyb3BfdGFibGUobWF0ZXJpYWxpemVkVmlld3MsIGNhbGxiYWNrKSB7XG4gICAgY29uc3QgcHJvcGVydGllcyA9IHRoaXMuX3Byb3BlcnRpZXM7XG4gICAgY29uc3QgdGFibGVOYW1lID0gcHJvcGVydGllcy50YWJsZV9uYW1lO1xuICAgIGNvbnN0IG1lc3NhZ2UgPSB1dGlsLmZvcm1hdChcbiAgICAgICdTY2hlbWEgZm9yIHRhYmxlIFwiJXNcIiBoYXMgY2hhbmdlZCBpbiBhIHdheSB3aGVyZSBhbHRlciBtaWdyYXRpb24gaXMgbm90IHBvc3NpYmxlLCBhbGwgZGF0YSBpbiB0aGUgdGFibGUgd2lsbCBiZSBsb3N0LCBhcmUgeW91IHN1cmUgeW91IHdhbnQgdG8gZHJvcCB0aGUgdGFibGU/JyxcbiAgICAgIHRhYmxlTmFtZSxcbiAgICApO1xuICAgIGNvbnN0IHBlcm1pc3Npb24gPSB0aGlzLl9jb25maXJtX21pZ3JhdGlvbihtZXNzYWdlKTtcbiAgICBpZiAocGVybWlzc2lvbiAhPT0gJ3knKSB7XG4gICAgICBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC50YWJsZWNyZWF0aW9uLnNjaGVtYW1pc21hdGNoJywgdGFibGVOYW1lLCAnbWlncmF0aW9uIHN1c3BlbmRlZCwgcGxlYXNlIGFwcGx5IHRoZSBjaGFuZ2UgbWFudWFsbHknKSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmICghbWF0ZXJpYWxpemVkVmlld3MpIHtcbiAgICAgIHRoaXMuX2Ryb3BfdGFibGUodGFibGVOYW1lLCBjYWxsYmFjayk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3QgbXZpZXdzID0gT2JqZWN0LmtleXMobWF0ZXJpYWxpemVkVmlld3MpO1xuICAgIHRoaXMuZHJvcF9tdmlld3MobXZpZXdzLCAoZXJyKSA9PiB7XG4gICAgICBpZiAoZXJyKSB7XG4gICAgICAgIGNhbGxiYWNrKGVycik7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgdGhpcy5fZHJvcF90YWJsZSh0YWJsZU5hbWUsIGNhbGxiYWNrKTtcbiAgICB9KTtcbiAgfSxcblxuICBkcm9wX3JlY3JlYXRlX3RhYmxlKG1vZGVsU2NoZW1hLCBtYXRlcmlhbGl6ZWRWaWV3cywgY2FsbGJhY2spIHtcbiAgICBpZiAodGhpcy5fZXNfYnVpbGRlcikge1xuICAgICAgY29uc3QgaW5kZXhOYW1lID0gYCR7dGhpcy5fcHJvcGVydGllcy5rZXlzcGFjZX1fJHt0aGlzLl9wcm9wZXJ0aWVzLnRhYmxlX25hbWV9YDtcbiAgICAgIHRoaXMuX2VzX2J1aWxkZXIuZGVsZXRlX2luZGV4KGluZGV4TmFtZSwgKCkgPT4ge1xuICAgICAgICB0aGlzLmRyb3BfdGFibGUobWF0ZXJpYWxpemVkVmlld3MsIChlcnIxKSA9PiB7XG4gICAgICAgICAgaWYgKGVycjEpIHtcbiAgICAgICAgICAgIGNhbGxiYWNrKGVycjEpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH1cbiAgICAgICAgICB0aGlzLmNyZWF0ZV90YWJsZShtb2RlbFNjaGVtYSwgY2FsbGJhY2spO1xuICAgICAgICB9KTtcbiAgICAgIH0pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICB0aGlzLmRyb3BfdGFibGUobWF0ZXJpYWxpemVkVmlld3MsIChlcnIxKSA9PiB7XG4gICAgICBpZiAoZXJyMSkge1xuICAgICAgICBjYWxsYmFjayhlcnIxKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgdGhpcy5jcmVhdGVfdGFibGUobW9kZWxTY2hlbWEsIGNhbGxiYWNrKTtcbiAgICB9KTtcbiAgfSxcblxuICBnZXRfaW5kZXhlcyhjYWxsYmFjaykge1xuICAgIGNvbnN0IHByb3BlcnRpZXMgPSB0aGlzLl9wcm9wZXJ0aWVzO1xuICAgIGNvbnN0IGtleXNwYWNlTmFtZSA9IHByb3BlcnRpZXMua2V5c3BhY2U7XG4gICAgY29uc3QgdGFibGVOYW1lID0gcHJvcGVydGllcy50YWJsZV9uYW1lO1xuICAgIGNvbnN0IGRiU2NoZW1hID0ge307XG4gICAgY29uc3QgcXVlcnkgPSAnU0VMRUNUICogRlJPTSBzeXN0ZW1fc2NoZW1hLmluZGV4ZXMgV0hFUkUgdGFibGVfbmFtZSA9ID8gQU5EIGtleXNwYWNlX25hbWUgPSA/Oyc7XG5cbiAgICB0aGlzLl9kcml2ZXIuZXhlY3V0ZV9xdWVyeShxdWVyeSwgW3RhYmxlTmFtZSwga2V5c3BhY2VOYW1lXSwgKGVyciwgcmVzdWx0SW5kZXhlcykgPT4ge1xuICAgICAgaWYgKGVycikge1xuICAgICAgICBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC50YWJsZWNyZWF0aW9uLmRic2NoZW1hcXVlcnknLCBlcnIpKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBmb3IgKGxldCByID0gMDsgciA8IHJlc3VsdEluZGV4ZXMucm93cy5sZW5ndGg7IHIrKykge1xuICAgICAgICBjb25zdCByb3cgPSByZXN1bHRJbmRleGVzLnJvd3Nbcl07XG5cbiAgICAgICAgaWYgKHJvdy5pbmRleF9uYW1lICYmIHJvdy5vcHRpb25zLnRhcmdldCkge1xuICAgICAgICAgIGNvbnN0IGluZGV4T3B0aW9ucyA9IHJvdy5vcHRpb25zO1xuICAgICAgICAgIGxldCB0YXJnZXQgPSBpbmRleE9wdGlvbnMudGFyZ2V0O1xuICAgICAgICAgIHRhcmdldCA9IHRhcmdldC5yZXBsYWNlKC9bXCJcXHNdL2csICcnKTtcbiAgICAgICAgICBkZWxldGUgaW5kZXhPcHRpb25zLnRhcmdldDtcblxuICAgICAgICAgIC8vIGtlZXBpbmcgdHJhY2sgb2YgaW5kZXggbmFtZXMgdG8gZHJvcCBpbmRleCB3aGVuIG5lZWRlZFxuICAgICAgICAgIGlmICghZGJTY2hlbWEuaW5kZXhfbmFtZXMpIGRiU2NoZW1hLmluZGV4X25hbWVzID0ge307XG5cbiAgICAgICAgICBpZiAocm93LmtpbmQgPT09ICdDVVNUT00nKSB7XG4gICAgICAgICAgICBjb25zdCB1c2luZyA9IGluZGV4T3B0aW9ucy5jbGFzc19uYW1lO1xuICAgICAgICAgICAgZGVsZXRlIGluZGV4T3B0aW9ucy5jbGFzc19uYW1lO1xuXG4gICAgICAgICAgICBpZiAoIWRiU2NoZW1hLmN1c3RvbV9pbmRleGVzKSBkYlNjaGVtYS5jdXN0b21faW5kZXhlcyA9IFtdO1xuICAgICAgICAgICAgY29uc3QgY3VzdG9tSW5kZXhPYmplY3QgPSB7XG4gICAgICAgICAgICAgIG9uOiB0YXJnZXQsXG4gICAgICAgICAgICAgIHVzaW5nLFxuICAgICAgICAgICAgICBvcHRpb25zOiBpbmRleE9wdGlvbnMsXG4gICAgICAgICAgICB9O1xuICAgICAgICAgICAgZGJTY2hlbWEuY3VzdG9tX2luZGV4ZXMucHVzaChjdXN0b21JbmRleE9iamVjdCk7XG4gICAgICAgICAgICBkYlNjaGVtYS5pbmRleF9uYW1lc1tvYmplY3RIYXNoKGN1c3RvbUluZGV4T2JqZWN0KV0gPSByb3cuaW5kZXhfbmFtZTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgaWYgKCFkYlNjaGVtYS5pbmRleGVzKSBkYlNjaGVtYS5pbmRleGVzID0gW107XG4gICAgICAgICAgICBkYlNjaGVtYS5pbmRleGVzLnB1c2godGFyZ2V0KTtcbiAgICAgICAgICAgIGRiU2NoZW1hLmluZGV4X25hbWVzW3RhcmdldF0gPSByb3cuaW5kZXhfbmFtZTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgY2FsbGJhY2sobnVsbCwgZGJTY2hlbWEpO1xuICAgIH0pO1xuICB9LFxuXG4gIF9jcmVhdGVfaW5kZXhfcXVlcnkodGFibGVOYW1lLCBpbmRleE5hbWUpIHtcbiAgICBsZXQgcXVlcnk7XG4gICAgY29uc3QgaW5kZXhFeHByZXNzaW9uID0gaW5kZXhOYW1lLnJlcGxhY2UoL1tcIlxcc10vZywgJycpLnNwbGl0KC9bKCldL2cpO1xuICAgIGlmIChpbmRleEV4cHJlc3Npb24ubGVuZ3RoID4gMSkge1xuICAgICAgaW5kZXhFeHByZXNzaW9uWzBdID0gaW5kZXhFeHByZXNzaW9uWzBdLnRvTG93ZXJDYXNlKCk7XG4gICAgICBxdWVyeSA9IHV0aWwuZm9ybWF0KFxuICAgICAgICAnQ1JFQVRFIElOREVYIElGIE5PVCBFWElTVFMgT04gXCIlc1wiICglcyhcIiVzXCIpKTsnLFxuICAgICAgICB0YWJsZU5hbWUsXG4gICAgICAgIGluZGV4RXhwcmVzc2lvblswXSxcbiAgICAgICAgaW5kZXhFeHByZXNzaW9uWzFdLFxuICAgICAgKTtcbiAgICB9IGVsc2Uge1xuICAgICAgcXVlcnkgPSB1dGlsLmZvcm1hdChcbiAgICAgICAgJ0NSRUFURSBJTkRFWCBJRiBOT1QgRVhJU1RTIE9OIFwiJXNcIiAoXCIlc1wiKTsnLFxuICAgICAgICB0YWJsZU5hbWUsXG4gICAgICAgIGluZGV4RXhwcmVzc2lvblswXSxcbiAgICAgICk7XG4gICAgfVxuICAgIHJldHVybiBxdWVyeTtcbiAgfSxcblxuICBjcmVhdGVfaW5kZXhlcyhpbmRleGVzLCBjYWxsYmFjaykge1xuICAgIGNvbnN0IHByb3BlcnRpZXMgPSB0aGlzLl9wcm9wZXJ0aWVzO1xuICAgIGNvbnN0IHRhYmxlTmFtZSA9IHByb3BlcnRpZXMudGFibGVfbmFtZTtcbiAgICBhc3luYy5lYWNoU2VyaWVzKGluZGV4ZXMsIChpZHgsIG5leHQpID0+IHtcbiAgICAgIGNvbnN0IHF1ZXJ5ID0gdGhpcy5fY3JlYXRlX2luZGV4X3F1ZXJ5KHRhYmxlTmFtZSwgaWR4KTtcbiAgICAgIHRoaXMuX2RyaXZlci5leGVjdXRlX2RlZmluaXRpb25fcXVlcnkocXVlcnksIChlcnIsIHJlc3VsdCkgPT4ge1xuICAgICAgICBpZiAoZXJyKSBuZXh0KGJ1aWxkRXJyb3IoJ21vZGVsLnRhYmxlY3JlYXRpb24uZGJpbmRleGNyZWF0ZScsIGVycikpO1xuICAgICAgICBlbHNlIG5leHQobnVsbCwgcmVzdWx0KTtcbiAgICAgIH0pO1xuICAgIH0sIGNhbGxiYWNrKTtcbiAgfSxcblxuICBfY3JlYXRlX2N1c3RvbV9pbmRleF9xdWVyeSh0YWJsZU5hbWUsIGN1c3RvbUluZGV4KSB7XG4gICAgbGV0IHF1ZXJ5ID0gdXRpbC5mb3JtYXQoXG4gICAgICAnQ1JFQVRFIENVU1RPTSBJTkRFWCBJRiBOT1QgRVhJU1RTIE9OIFwiJXNcIiAoXCIlc1wiKSBVU0lORyBcXCclc1xcJycsXG4gICAgICB0YWJsZU5hbWUsXG4gICAgICBjdXN0b21JbmRleC5vbixcbiAgICAgIGN1c3RvbUluZGV4LnVzaW5nLFxuICAgICk7XG5cbiAgICBpZiAoT2JqZWN0LmtleXMoY3VzdG9tSW5kZXgub3B0aW9ucykubGVuZ3RoID4gMCkge1xuICAgICAgcXVlcnkgKz0gJyBXSVRIIE9QVElPTlMgPSB7JztcbiAgICAgIE9iamVjdC5rZXlzKGN1c3RvbUluZGV4Lm9wdGlvbnMpLmZvckVhY2goKGtleSkgPT4ge1xuICAgICAgICBxdWVyeSArPSB1dGlsLmZvcm1hdChcIiclcyc6ICclcycsIFwiLCBrZXksIGN1c3RvbUluZGV4Lm9wdGlvbnNba2V5XSk7XG4gICAgICB9KTtcbiAgICAgIHF1ZXJ5ID0gcXVlcnkuc2xpY2UoMCwgLTIpO1xuICAgICAgcXVlcnkgKz0gJ30nO1xuICAgIH1cblxuICAgIHF1ZXJ5ICs9ICc7JztcblxuICAgIHJldHVybiBxdWVyeTtcbiAgfSxcblxuICBjcmVhdGVfY3VzdG9tX2luZGV4ZXMoY3VzdG9tSW5kZXhlcywgY2FsbGJhY2spIHtcbiAgICBjb25zdCBwcm9wZXJ0aWVzID0gdGhpcy5fcHJvcGVydGllcztcbiAgICBjb25zdCB0YWJsZU5hbWUgPSBwcm9wZXJ0aWVzLnRhYmxlX25hbWU7XG4gICAgYXN5bmMuZWFjaFNlcmllcyhjdXN0b21JbmRleGVzLCAoaWR4LCBuZXh0KSA9PiB7XG4gICAgICBjb25zdCBxdWVyeSA9IHRoaXMuX2NyZWF0ZV9jdXN0b21faW5kZXhfcXVlcnkodGFibGVOYW1lLCBpZHgpO1xuICAgICAgdGhpcy5fZHJpdmVyLmV4ZWN1dGVfZGVmaW5pdGlvbl9xdWVyeShxdWVyeSwgKGVyciwgcmVzdWx0KSA9PiB7XG4gICAgICAgIGlmIChlcnIpIG5leHQoYnVpbGRFcnJvcignbW9kZWwudGFibGVjcmVhdGlvbi5kYmluZGV4Y3JlYXRlJywgZXJyKSk7XG4gICAgICAgIGVsc2UgbmV4dChudWxsLCByZXN1bHQpO1xuICAgICAgfSk7XG4gICAgfSwgY2FsbGJhY2spO1xuICB9LFxuXG4gIGRyb3BfaW5kZXhlcyhpbmRleGVzLCBjYWxsYmFjaykge1xuICAgIGFzeW5jLmVhY2goaW5kZXhlcywgKGlkeCwgbmV4dCkgPT4ge1xuICAgICAgY29uc3QgcXVlcnkgPSB1dGlsLmZvcm1hdCgnRFJPUCBJTkRFWCBJRiBFWElTVFMgXCIlc1wiOycsIGlkeCk7XG4gICAgICB0aGlzLl9kcml2ZXIuZXhlY3V0ZV9kZWZpbml0aW9uX3F1ZXJ5KHF1ZXJ5LCBuZXh0KTtcbiAgICB9LCAoZXJyKSA9PiB7XG4gICAgICBpZiAoZXJyKSBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC50YWJsZWNyZWF0aW9uLmRiaW5kZXhkcm9wJywgZXJyKSk7XG4gICAgICBlbHNlIGNhbGxiYWNrKCk7XG4gICAgfSk7XG4gIH0sXG5cbiAgZ2V0X212aWV3cyhjYWxsYmFjaykge1xuICAgIGNvbnN0IHByb3BlcnRpZXMgPSB0aGlzLl9wcm9wZXJ0aWVzO1xuICAgIGNvbnN0IGtleXNwYWNlTmFtZSA9IHByb3BlcnRpZXMua2V5c3BhY2U7XG4gICAgY29uc3QgdGFibGVOYW1lID0gcHJvcGVydGllcy50YWJsZV9uYW1lO1xuICAgIGNvbnN0IGRiU2NoZW1hID0ge307XG4gICAgbGV0IHF1ZXJ5ID0gJ1NFTEVDVCB2aWV3X25hbWUsYmFzZV90YWJsZV9uYW1lLHdoZXJlX2NsYXVzZSBGUk9NIHN5c3RlbV9zY2hlbWEudmlld3MgV0hFUkUga2V5c3BhY2VfbmFtZT0/IEFORCBiYXNlX3RhYmxlX25hbWU9PyBBTExPVyBGSUxURVJJTkc7JztcblxuICAgIHRoaXMuX2RyaXZlci5leGVjdXRlX3F1ZXJ5KHF1ZXJ5LCBba2V5c3BhY2VOYW1lLCB0YWJsZU5hbWVdLCAoZXJyLCByZXN1bHRWaWV3cykgPT4ge1xuICAgICAgaWYgKGVycikge1xuICAgICAgICBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC50YWJsZWNyZWF0aW9uLmRic2NoZW1hcXVlcnknLCBlcnIpKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBmb3IgKGxldCByID0gMDsgciA8IHJlc3VsdFZpZXdzLnJvd3MubGVuZ3RoOyByKyspIHtcbiAgICAgICAgY29uc3Qgcm93ID0gcmVzdWx0Vmlld3Mucm93c1tyXTtcblxuICAgICAgICBpZiAocm93LnZpZXdfbmFtZSkge1xuICAgICAgICAgIGlmICghZGJTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzKSBkYlNjaGVtYS5tYXRlcmlhbGl6ZWRfdmlld3MgPSB7fTtcbiAgICAgICAgICBkYlNjaGVtYS5tYXRlcmlhbGl6ZWRfdmlld3Nbcm93LnZpZXdfbmFtZV0gPSB7XG4gICAgICAgICAgICB3aGVyZV9jbGF1c2U6IHJvdy53aGVyZV9jbGF1c2UsXG4gICAgICAgICAgfTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBpZiAoIWRiU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3cykge1xuICAgICAgICBjYWxsYmFjayhudWxsLCBkYlNjaGVtYSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgcXVlcnkgPSAnU0VMRUNUICogRlJPTSBzeXN0ZW1fc2NoZW1hLmNvbHVtbnMgV0hFUkUga2V5c3BhY2VfbmFtZT0/IGFuZCB0YWJsZV9uYW1lIElOID87JztcblxuICAgICAgY29uc3Qgdmlld05hbWVzID0gT2JqZWN0LmtleXMoZGJTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzKTtcbiAgICAgIHRoaXMuX2RyaXZlci5leGVjdXRlX3F1ZXJ5KHF1ZXJ5LCBba2V5c3BhY2VOYW1lLCB2aWV3TmFtZXNdLCAoZXJyMSwgcmVzdWx0TWF0Vmlld3MpID0+IHtcbiAgICAgICAgaWYgKGVycjEpIHtcbiAgICAgICAgICBjYWxsYmFjayhidWlsZEVycm9yKCdtb2RlbC50YWJsZWNyZWF0aW9uLmRic2NoZW1hcXVlcnknLCBlcnIxKSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgZm9yIChsZXQgciA9IDA7IHIgPCByZXN1bHRNYXRWaWV3cy5yb3dzLmxlbmd0aDsgcisrKSB7XG4gICAgICAgICAgY29uc3Qgcm93ID0gcmVzdWx0TWF0Vmlld3Mucm93c1tyXTtcblxuICAgICAgICAgIGlmICghZGJTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzW3Jvdy50YWJsZV9uYW1lXS5zZWxlY3QpIHtcbiAgICAgICAgICAgIGRiU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3c1tyb3cudGFibGVfbmFtZV0uc2VsZWN0ID0gW107XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgZGJTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzW3Jvdy50YWJsZV9uYW1lXS5zZWxlY3QucHVzaChyb3cuY29sdW1uX25hbWUpO1xuXG4gICAgICAgICAgaWYgKHJvdy5raW5kID09PSAncGFydGl0aW9uX2tleScpIHtcbiAgICAgICAgICAgIGlmICghZGJTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzW3Jvdy50YWJsZV9uYW1lXS5rZXkpIHtcbiAgICAgICAgICAgICAgZGJTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzW3Jvdy50YWJsZV9uYW1lXS5rZXkgPSBbW11dO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBkYlNjaGVtYS5tYXRlcmlhbGl6ZWRfdmlld3Nbcm93LnRhYmxlX25hbWVdLmtleVswXVtyb3cucG9zaXRpb25dID0gcm93LmNvbHVtbl9uYW1lO1xuICAgICAgICAgIH0gZWxzZSBpZiAocm93LmtpbmQgPT09ICdjbHVzdGVyaW5nJykge1xuICAgICAgICAgICAgaWYgKCFkYlNjaGVtYS5tYXRlcmlhbGl6ZWRfdmlld3Nbcm93LnRhYmxlX25hbWVdLmtleSkge1xuICAgICAgICAgICAgICBkYlNjaGVtYS5tYXRlcmlhbGl6ZWRfdmlld3Nbcm93LnRhYmxlX25hbWVdLmtleSA9IFtbXV07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoIWRiU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3c1tyb3cudGFibGVfbmFtZV0uY2x1c3RlcmluZ19vcmRlcikge1xuICAgICAgICAgICAgICBkYlNjaGVtYS5tYXRlcmlhbGl6ZWRfdmlld3Nbcm93LnRhYmxlX25hbWVdLmNsdXN0ZXJpbmdfb3JkZXIgPSB7fTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZGJTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzW3Jvdy50YWJsZV9uYW1lXS5rZXlbcm93LnBvc2l0aW9uICsgMV0gPSByb3cuY29sdW1uX25hbWU7XG4gICAgICAgICAgICBpZiAocm93LmNsdXN0ZXJpbmdfb3JkZXIgJiYgcm93LmNsdXN0ZXJpbmdfb3JkZXIudG9Mb3dlckNhc2UoKSA9PT0gJ2Rlc2MnKSB7XG4gICAgICAgICAgICAgIGRiU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3c1tyb3cudGFibGVfbmFtZV0uY2x1c3RlcmluZ19vcmRlcltyb3cuY29sdW1uX25hbWVdID0gJ0RFU0MnO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgZGJTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzW3Jvdy50YWJsZV9uYW1lXS5jbHVzdGVyaW5nX29yZGVyW3Jvdy5jb2x1bW5fbmFtZV0gPSAnQVNDJztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBjYWxsYmFjayhudWxsLCBkYlNjaGVtYSk7XG4gICAgICB9KTtcbiAgICB9KTtcbiAgfSxcblxuICBfY3JlYXRlX21hdGVyaWFsaXplZF92aWV3X3F1ZXJ5KHRhYmxlTmFtZSwgdmlld05hbWUsIHZpZXdTY2hlbWEpIHtcbiAgICBjb25zdCByb3dzID0gW107XG5cbiAgICBmb3IgKGxldCBrID0gMDsgayA8IHZpZXdTY2hlbWEuc2VsZWN0Lmxlbmd0aDsgaysrKSB7XG4gICAgICBpZiAodmlld1NjaGVtYS5zZWxlY3Rba10gPT09ICcqJykgcm93cy5wdXNoKHV0aWwuZm9ybWF0KCclcycsIHZpZXdTY2hlbWEuc2VsZWN0W2tdKSk7XG4gICAgICBlbHNlIHJvd3MucHVzaCh1dGlsLmZvcm1hdCgnXCIlc1wiJywgdmlld1NjaGVtYS5zZWxlY3Rba10pKTtcbiAgICB9XG5cbiAgICBjb25zdCB3aGVyZUNsYXVzZSA9IHZpZXdTY2hlbWEud2hlcmVfY2xhdXNlIHx8IHBhcnNlci5nZXRfbXZpZXdfd2hlcmVfY2xhdXNlKHRoaXMuX3Byb3BlcnRpZXMuc2NoZW1hLCB2aWV3U2NoZW1hKTtcbiAgICBjb25zdCBjbGF1c2VzID0gcGFyc2VyLmdldF9wcmltYXJ5X2tleV9jbGF1c2VzKHZpZXdTY2hlbWEpO1xuXG4gICAgY29uc3QgcXVlcnkgPSB1dGlsLmZvcm1hdChcbiAgICAgICdDUkVBVEUgTUFURVJJQUxJWkVEIFZJRVcgSUYgTk9UIEVYSVNUUyBcIiVzXCIgQVMgU0VMRUNUICVzIEZST00gXCIlc1wiIFdIRVJFICVzIFBSSU1BUlkgS0VZKCglcyklcyklczsnLFxuICAgICAgdmlld05hbWUsXG4gICAgICByb3dzLmpvaW4oJyAsICcpLFxuICAgICAgdGFibGVOYW1lLFxuICAgICAgd2hlcmVDbGF1c2UsXG4gICAgICBjbGF1c2VzLnBhcnRpdGlvbktleUNsYXVzZSxcbiAgICAgIGNsYXVzZXMuY2x1c3RlcmluZ0tleUNsYXVzZSxcbiAgICAgIGNsYXVzZXMuY2x1c3RlcmluZ09yZGVyQ2xhdXNlLFxuICAgICk7XG5cbiAgICByZXR1cm4gcXVlcnk7XG4gIH0sXG5cbiAgY3JlYXRlX212aWV3cyhtYXRlcmlhbGl6ZWRWaWV3cywgY2FsbGJhY2spIHtcbiAgICBjb25zdCBwcm9wZXJ0aWVzID0gdGhpcy5fcHJvcGVydGllcztcbiAgICBjb25zdCB0YWJsZU5hbWUgPSBwcm9wZXJ0aWVzLnRhYmxlX25hbWU7XG4gICAgYXN5bmMuZWFjaFNlcmllcyhPYmplY3Qua2V5cyhtYXRlcmlhbGl6ZWRWaWV3cyksICh2aWV3TmFtZSwgbmV4dCkgPT4ge1xuICAgICAgY29uc3QgcXVlcnkgPSB0aGlzLl9jcmVhdGVfbWF0ZXJpYWxpemVkX3ZpZXdfcXVlcnkoXG4gICAgICAgIHRhYmxlTmFtZSxcbiAgICAgICAgdmlld05hbWUsXG4gICAgICAgIG1hdGVyaWFsaXplZFZpZXdzW3ZpZXdOYW1lXSxcbiAgICAgICk7XG4gICAgICB0aGlzLl9kcml2ZXIuZXhlY3V0ZV9kZWZpbml0aW9uX3F1ZXJ5KHF1ZXJ5LCAoZXJyLCByZXN1bHQpID0+IHtcbiAgICAgICAgaWYgKGVycikgbmV4dChidWlsZEVycm9yKCdtb2RlbC50YWJsZWNyZWF0aW9uLm1hdHZpZXdjcmVhdGUnLCBlcnIpKTtcbiAgICAgICAgZWxzZSBuZXh0KG51bGwsIHJlc3VsdCk7XG4gICAgICB9KTtcbiAgICB9LCBjYWxsYmFjayk7XG4gIH0sXG5cbiAgZHJvcF9tdmlld3MobXZpZXdzLCBjYWxsYmFjaykge1xuICAgIGFzeW5jLmVhY2gobXZpZXdzLCAodmlldywgbmV4dCkgPT4ge1xuICAgICAgY29uc3QgcXVlcnkgPSB1dGlsLmZvcm1hdCgnRFJPUCBNQVRFUklBTElaRUQgVklFVyBJRiBFWElTVFMgXCIlc1wiOycsIHZpZXcpO1xuICAgICAgdGhpcy5fZHJpdmVyLmV4ZWN1dGVfZGVmaW5pdGlvbl9xdWVyeShxdWVyeSwgbmV4dCk7XG4gICAgfSwgKGVycikgPT4ge1xuICAgICAgaWYgKGVycikgY2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwudGFibGVjcmVhdGlvbi5tYXR2aWV3ZHJvcCcsIGVycikpO1xuICAgICAgZWxzZSBjYWxsYmFjaygpO1xuICAgIH0pO1xuICB9LFxuXG4gIF9hcHBseV9hbHRlcl9vcGVyYXRpb25zKGFsdGVyT3BlcmF0aW9ucywgZGJTY2hlbWEsIG5vcm1hbGl6ZWRNb2RlbFNjaGVtYSwgbm9ybWFsaXplZERCU2NoZW1hLCBjYWxsYmFjaykge1xuICAgIC8vIGl0IHNob3VsZCBjcmVhdGUvZHJvcCBpbmRleGVzL2N1c3RvbV9pbmRleGVzL21hdGVyaWFsaXplZF92aWV3cyB0aGF0IGFyZSBhZGRlZC9yZW1vdmVkIGluIG1vZGVsIHNjaGVtYVxuICAgIC8vIHJlbW92ZSBjb21tb24gaW5kZXhlcy9jdXN0b21faW5kZXhlcy9tYXRlcmlhbGl6ZWRfdmlld3MgZnJvbSBub3JtYWxpemVkTW9kZWxTY2hlbWEgYW5kIG5vcm1hbGl6ZWREQlNjaGVtYVxuICAgIC8vIHRoZW4gZHJvcCBhbGwgcmVtYWluaW5nIGluZGV4ZXMvY3VzdG9tX2luZGV4ZXMvbWF0ZXJpYWxpemVkX3ZpZXdzIGZyb20gbm9ybWFsaXplZERCU2NoZW1hXG4gICAgLy8gYW5kIGFkZCBhbGwgcmVtYWluaW5nIGluZGV4ZXMvY3VzdG9tX2luZGV4ZXMvbWF0ZXJpYWxpemVkX3ZpZXdzIGZyb20gbm9ybWFsaXplZE1vZGVsU2NoZW1hXG4gICAgY29uc3QgcHJvcGVydGllcyA9IHRoaXMuX3Byb3BlcnRpZXM7XG4gICAgY29uc3QgdGFibGVOYW1lID0gcHJvcGVydGllcy50YWJsZV9uYW1lO1xuICAgIGNvbnN0IGFkZGVkSW5kZXhlcyA9IF8uZGlmZmVyZW5jZShub3JtYWxpemVkTW9kZWxTY2hlbWEuaW5kZXhlcywgbm9ybWFsaXplZERCU2NoZW1hLmluZGV4ZXMpO1xuICAgIGNvbnN0IHJlbW92ZWRJbmRleGVzID0gXy5kaWZmZXJlbmNlKG5vcm1hbGl6ZWREQlNjaGVtYS5pbmRleGVzLCBub3JtYWxpemVkTW9kZWxTY2hlbWEuaW5kZXhlcyk7XG4gICAgY29uc3QgcmVtb3ZlZEluZGV4TmFtZXMgPSBbXTtcbiAgICByZW1vdmVkSW5kZXhlcy5mb3JFYWNoKChyZW1vdmVkSW5kZXgpID0+IHtcbiAgICAgIHJlbW92ZWRJbmRleE5hbWVzLnB1c2goZGJTY2hlbWEuaW5kZXhfbmFtZXNbcmVtb3ZlZEluZGV4XSk7XG4gICAgfSk7XG5cbiAgICBjb25zdCBhZGRlZEN1c3RvbUluZGV4ZXMgPSBfLmZpbHRlcihcbiAgICAgIG5vcm1hbGl6ZWRNb2RlbFNjaGVtYS5jdXN0b21faW5kZXhlcyxcbiAgICAgIChvYmopID0+ICghXy5maW5kKG5vcm1hbGl6ZWREQlNjaGVtYS5jdXN0b21faW5kZXhlcywgb2JqKSksXG4gICAgKTtcbiAgICBjb25zdCByZW1vdmVkQ3VzdG9tSW5kZXhlcyA9IF8uZmlsdGVyKFxuICAgICAgbm9ybWFsaXplZERCU2NoZW1hLmN1c3RvbV9pbmRleGVzLFxuICAgICAgKG9iaikgPT4gKCFfLmZpbmQobm9ybWFsaXplZE1vZGVsU2NoZW1hLmN1c3RvbV9pbmRleGVzLCBvYmopKSxcbiAgICApO1xuICAgIHJlbW92ZWRDdXN0b21JbmRleGVzLmZvckVhY2goKHJlbW92ZWRJbmRleCkgPT4ge1xuICAgICAgcmVtb3ZlZEluZGV4TmFtZXMucHVzaChkYlNjaGVtYS5pbmRleF9uYW1lc1tvYmplY3RIYXNoKHJlbW92ZWRJbmRleCldKTtcbiAgICB9KTtcblxuICAgIGNvbnN0IGFkZGVkTWF0ZXJpYWxpemVkVmlld3NOYW1lcyA9IF8uZmlsdGVyKFxuICAgICAgT2JqZWN0LmtleXMobm9ybWFsaXplZE1vZGVsU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3cyksXG4gICAgICAodmlld05hbWUpID0+ICghXy5pc0VxdWFsKFxuICAgICAgICBub3JtYWxpemVkREJTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzW3ZpZXdOYW1lXSxcbiAgICAgICAgbm9ybWFsaXplZE1vZGVsU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3c1t2aWV3TmFtZV0sXG4gICAgICApKSxcbiAgICApO1xuXG4gICAgY29uc3QgcmVtb3ZlZE1hdGVyaWFsaXplZFZpZXdOYW1lcyA9IF8uZmlsdGVyKFxuICAgICAgT2JqZWN0LmtleXMobm9ybWFsaXplZERCU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3cyksXG4gICAgICAodmlld05hbWUpID0+ICghXy5pc0VxdWFsKFxuICAgICAgICBub3JtYWxpemVkREJTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzW3ZpZXdOYW1lXSxcbiAgICAgICAgbm9ybWFsaXplZE1vZGVsU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3c1t2aWV3TmFtZV0sXG4gICAgICApKSxcbiAgICApO1xuXG4gICAgY29uc3QgYWRkZWRNYXRlcmlhbGl6ZWRWaWV3cyA9IHt9O1xuICAgIGFkZGVkTWF0ZXJpYWxpemVkVmlld3NOYW1lcy5mb3JFYWNoKCh2aWV3TmFtZSkgPT4ge1xuICAgICAgYWRkZWRNYXRlcmlhbGl6ZWRWaWV3c1t2aWV3TmFtZV0gPSBub3JtYWxpemVkTW9kZWxTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzW3ZpZXdOYW1lXTtcbiAgICB9KTtcblxuICAgIC8vIHJlbW92ZSBhbHRlcmVkIG1hdGVyaWFsaXplZCB2aWV3c1xuICAgIGlmIChyZW1vdmVkTWF0ZXJpYWxpemVkVmlld05hbWVzLmxlbmd0aCA+IDApIHtcbiAgICAgIGNvbnN0IG1lc3NhZ2UgPSB1dGlsLmZvcm1hdChcbiAgICAgICAgJ1NjaGVtYSBmb3IgdGFibGUgXCIlc1wiIGhhcyByZW1vdmVkIG1hdGVyaWFsaXplZF92aWV3czogJWosIGFyZSB5b3Ugc3VyZSB5b3Ugd2FudCB0byBkcm9wIHRoZW0/JyxcbiAgICAgICAgdGFibGVOYW1lLFxuICAgICAgICByZW1vdmVkTWF0ZXJpYWxpemVkVmlld05hbWVzLFxuICAgICAgKTtcbiAgICAgIGNvbnN0IHBlcm1pc3Npb24gPSB0aGlzLl9jb25maXJtX21pZ3JhdGlvbihtZXNzYWdlKTtcbiAgICAgIGlmIChwZXJtaXNzaW9uICE9PSAneScpIHtcbiAgICAgICAgY2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwudGFibGVjcmVhdGlvbi5zY2hlbWFtaXNtYXRjaCcsIHRhYmxlTmFtZSwgJ21pZ3JhdGlvbiBzdXNwZW5kZWQsIHBsZWFzZSBhcHBseSB0aGUgY2hhbmdlIG1hbnVhbGx5JykpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgfVxuXG4gICAgdGhpcy5kcm9wX212aWV3cyhyZW1vdmVkTWF0ZXJpYWxpemVkVmlld05hbWVzLCAoZXJyMikgPT4ge1xuICAgICAgaWYgKGVycjIpIHtcbiAgICAgICAgY2FsbGJhY2soZXJyMik7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgaWYgKHJlbW92ZWRJbmRleE5hbWVzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgY29uc3QgbWVzc2FnZSA9IHV0aWwuZm9ybWF0KFxuICAgICAgICAgICdTY2hlbWEgZm9yIHRhYmxlIFwiJXNcIiBoYXMgcmVtb3ZlZCBpbmRleGVzOiAlaiwgYXJlIHlvdSBzdXJlIHlvdSB3YW50IHRvIGRyb3AgdGhlbT8nLFxuICAgICAgICAgIHRhYmxlTmFtZSxcbiAgICAgICAgICByZW1vdmVkSW5kZXhOYW1lcyxcbiAgICAgICAgKTtcbiAgICAgICAgY29uc3QgcGVybWlzc2lvbiA9IHRoaXMuX2NvbmZpcm1fbWlncmF0aW9uKG1lc3NhZ2UpO1xuICAgICAgICBpZiAocGVybWlzc2lvbiAhPT0gJ3knKSB7XG4gICAgICAgICAgY2FsbGJhY2soYnVpbGRFcnJvcignbW9kZWwudGFibGVjcmVhdGlvbi5zY2hlbWFtaXNtYXRjaCcsIHRhYmxlTmFtZSwgJ21pZ3JhdGlvbiBzdXNwZW5kZWQsIHBsZWFzZSBhcHBseSB0aGUgY2hhbmdlIG1hbnVhbGx5JykpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyByZW1vdmUgYWx0ZXJlZCBpbmRleGVzIGJ5IGluZGV4IG5hbWVcbiAgICAgIHRoaXMuZHJvcF9pbmRleGVzKHJlbW92ZWRJbmRleE5hbWVzLCAoZXJyMykgPT4ge1xuICAgICAgICBpZiAoZXJyMykge1xuICAgICAgICAgIGNhbGxiYWNrKGVycjMpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIG5vdyBhcHBseSBhbHRlck9wZXJhdGlvbnMgaGVyZVxuICAgICAgICBhc3luYy5lYWNoU2VyaWVzKGFsdGVyT3BlcmF0aW9ucywgKGFsdGVyT3BlcmF0aW9uLCBuZXh0KSA9PiB7XG4gICAgICAgICAgY29uc3QgcGVybWlzc2lvbiA9IHRoaXMuX2NvbmZpcm1fbWlncmF0aW9uKGFsdGVyT3BlcmF0aW9uLm1lc3NhZ2UpO1xuICAgICAgICAgIGlmIChwZXJtaXNzaW9uICE9PSAneScpIHtcbiAgICAgICAgICAgIGNhbGxiYWNrKGJ1aWxkRXJyb3IoJ21vZGVsLnRhYmxlY3JlYXRpb24uc2NoZW1hbWlzbWF0Y2gnLCB0YWJsZU5hbWUsICdtaWdyYXRpb24gc3VzcGVuZGVkLCBwbGVhc2UgYXBwbHkgdGhlIGNoYW5nZSBtYW51YWxseScpKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICB9XG4gICAgICAgICAgdGhpcy5hbHRlcl90YWJsZShhbHRlck9wZXJhdGlvbi5vcGVyYXRpb24sIGFsdGVyT3BlcmF0aW9uLmZpZWxkTmFtZSwgYWx0ZXJPcGVyYXRpb24udHlwZSwgbmV4dCk7XG4gICAgICAgIH0sIChlcnI0KSA9PiB7XG4gICAgICAgICAgaWYgKGVycjQpIHtcbiAgICAgICAgICAgIGNhbGxiYWNrKGVycjQpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIC8vIGFkZCBhbHRlcmVkIGluZGV4ZXNcbiAgICAgICAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgbWF4LW5lc3RlZC1jYWxsYmFja3NcbiAgICAgICAgICB0aGlzLmNyZWF0ZV9pbmRleGVzKGFkZGVkSW5kZXhlcywgKGVycjUpID0+IHtcbiAgICAgICAgICAgIGlmIChlcnI1KSB7XG4gICAgICAgICAgICAgIGNhbGxiYWNrKGVycjUpO1xuICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIGFkZCBhbHRlcmVkIGN1c3RvbSBpbmRleGVzXG4gICAgICAgICAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgbWF4LW5lc3RlZC1jYWxsYmFja3NcbiAgICAgICAgICAgIHRoaXMuY3JlYXRlX2N1c3RvbV9pbmRleGVzKGFkZGVkQ3VzdG9tSW5kZXhlcywgKGVycjYpID0+IHtcbiAgICAgICAgICAgICAgaWYgKGVycjYpIHtcbiAgICAgICAgICAgICAgICBjYWxsYmFjayhlcnI2KTtcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAvLyBhZGQgYWx0ZXJlZCBtYXRlcmlhbGl6ZWRfdmlld3NcbiAgICAgICAgICAgICAgdGhpcy5jcmVhdGVfbXZpZXdzKGFkZGVkTWF0ZXJpYWxpemVkVmlld3MsIGNhbGxiYWNrKTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgIH0pO1xuICAgICAgICB9KTtcbiAgICAgIH0pO1xuICAgIH0pO1xuICB9LFxuXG4gIGluaXRfYWx0ZXJfb3BlcmF0aW9ucyhtb2RlbFNjaGVtYSwgZGJTY2hlbWEsIG5vcm1hbGl6ZWRNb2RlbFNjaGVtYSwgbm9ybWFsaXplZERCU2NoZW1hLCBjYWxsYmFjaykge1xuICAgIGNvbnN0IHByb3BlcnRpZXMgPSB0aGlzLl9wcm9wZXJ0aWVzO1xuICAgIGNvbnN0IHRhYmxlTmFtZSA9IHByb3BlcnRpZXMudGFibGVfbmFtZTtcbiAgICBjb25zdCBhbHRlck9wZXJhdGlvbnMgPSBbXTtcbiAgICBjb25zdCBkaWZmZXJlbmNlcyA9IGRlZXBEaWZmKG5vcm1hbGl6ZWREQlNjaGVtYS5maWVsZHMsIG5vcm1hbGl6ZWRNb2RlbFNjaGVtYS5maWVsZHMpO1xuICAgIGxldCBkcm9wcGVkRmllbGRzID0gZmFsc2U7XG4gICAgYXN5bmMuZWFjaFNlcmllcyhkaWZmZXJlbmNlcywgKGRpZmYsIG5leHQpID0+IHtcbiAgICAgIGNvbnN0IGZpZWxkTmFtZSA9IGRpZmYucGF0aFswXTtcbiAgICAgIGlmIChkaWZmLmtpbmQgPT09ICdOJykge1xuICAgICAgICBjb25zdCBtZXNzYWdlID0gdXRpbC5mb3JtYXQoXG4gICAgICAgICAgJ1NjaGVtYSBmb3IgdGFibGUgXCIlc1wiIGhhcyBhZGRlZCBmaWVsZCBcIiVzXCIsIGFyZSB5b3Ugc3VyZSB5b3Ugd2FudCB0byBhbHRlciB0byBhZGQgdGhlIGZpZWxkPycsXG4gICAgICAgICAgdGFibGVOYW1lLFxuICAgICAgICAgIGZpZWxkTmFtZSxcbiAgICAgICAgKTtcbiAgICAgICAgYWx0ZXJPcGVyYXRpb25zLnB1c2goe1xuICAgICAgICAgIGZpZWxkTmFtZSxcbiAgICAgICAgICBtZXNzYWdlLFxuICAgICAgICAgIG9wZXJhdGlvbjogJ0FERCcsXG4gICAgICAgICAgdHlwZTogcGFyc2VyLmV4dHJhY3RfYWx0ZXJlZF90eXBlKG5vcm1hbGl6ZWRNb2RlbFNjaGVtYSwgZGlmZiksXG4gICAgICAgIH0pO1xuICAgICAgICBuZXh0KCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGlmIChkaWZmLmtpbmQgPT09ICdEJykge1xuICAgICAgICBjb25zdCBtZXNzYWdlID0gdXRpbC5mb3JtYXQoXG4gICAgICAgICAgJ1NjaGVtYSBmb3IgdGFibGUgXCIlc1wiIGhhcyByZW1vdmVkIGZpZWxkIFwiJXNcIiwgYWxsIGRhdGEgaW4gdGhlIGZpZWxkIHdpbGwgbG9zdCwgYXJlIHlvdSBzdXJlIHlvdSB3YW50IHRvIGFsdGVyIHRvIGRyb3AgdGhlIGZpZWxkPycsXG4gICAgICAgICAgdGFibGVOYW1lLFxuICAgICAgICAgIGZpZWxkTmFtZSxcbiAgICAgICAgKTtcbiAgICAgICAgYWx0ZXJPcGVyYXRpb25zLnB1c2goe1xuICAgICAgICAgIGZpZWxkTmFtZSxcbiAgICAgICAgICBtZXNzYWdlLFxuICAgICAgICAgIG9wZXJhdGlvbjogJ0RST1AnLFxuICAgICAgICB9KTtcbiAgICAgICAgZHJvcHBlZEZpZWxkcyA9IHRydWU7XG4gICAgICAgIG5vcm1hbGl6ZXIucmVtb3ZlX2RlcGVuZGVudF92aWV3c19mcm9tX25vcm1hbGl6ZWRfc2NoZW1hKG5vcm1hbGl6ZWREQlNjaGVtYSwgZGJTY2hlbWEsIGZpZWxkTmFtZSk7XG4gICAgICAgIG5leHQoKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgaWYgKGRpZmYua2luZCA9PT0gJ0UnKSB7XG4gICAgICAgIC8vIGNoZWNrIGlmIHRoZSBhbHRlciBmaWVsZCB0eXBlIGlzIHBvc3NpYmxlLCBvdGhlcndpc2UgdHJ5IEQgYW5kIHRoZW4gTlxuICAgICAgICBpZiAoZGlmZi5wYXRoWzFdID09PSAndHlwZScpIHtcbiAgICAgICAgICAvLyBjaGVjayBpZiBmaWVsZCBwYXJ0IG9mIHByaW1hcnkga2V5XG4gICAgICAgICAgaWYgKG5vcm1hbGl6ZWREQlNjaGVtYS5rZXlbMF0uaW5jbHVkZXMoZmllbGROYW1lKSB8fCBub3JtYWxpemVkREJTY2hlbWEua2V5LmluZGV4T2YoZmllbGROYW1lKSA+IDApIHtcbiAgICAgICAgICAgIC8vIGFsdGVyIGZpZWxkIHR5cGUgaW1wb3NzaWJsZVxuICAgICAgICAgICAgbmV4dChuZXcgRXJyb3IoJ2FsdGVyX2ltcG9zc2libGUnKSk7XG4gICAgICAgICAgfSBlbHNlIGlmIChbJ3RleHQnLCAnYXNjaWknLCAnYmlnaW50JywgJ2Jvb2xlYW4nLCAnZGVjaW1hbCcsXG4gICAgICAgICAgICAnZG91YmxlJywgJ2Zsb2F0JywgJ2luZXQnLCAnaW50JywgJ3RpbWVzdGFtcCcsICd0aW1ldXVpZCcsXG4gICAgICAgICAgICAndXVpZCcsICd2YXJjaGFyJywgJ3ZhcmludCddLmluY2x1ZGVzKGRpZmYubGhzKSAmJiBkaWZmLnJocyA9PT0gJ2Jsb2InKSB7XG4gICAgICAgICAgICAvLyBhbHRlciBmaWVsZCB0eXBlIHBvc3NpYmxlXG4gICAgICAgICAgICBjb25zdCBtZXNzYWdlID0gdXRpbC5mb3JtYXQoXG4gICAgICAgICAgICAgICdTY2hlbWEgZm9yIHRhYmxlIFwiJXNcIiBoYXMgbmV3IHR5cGUgZm9yIGZpZWxkIFwiJXNcIiwgYXJlIHlvdSBzdXJlIHlvdSB3YW50IHRvIGFsdGVyIHRvIHVwZGF0ZSB0aGUgZmllbGQgdHlwZT8nLFxuICAgICAgICAgICAgICB0YWJsZU5hbWUsXG4gICAgICAgICAgICAgIGZpZWxkTmFtZSxcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICBhbHRlck9wZXJhdGlvbnMucHVzaCh7XG4gICAgICAgICAgICAgIGZpZWxkTmFtZSxcbiAgICAgICAgICAgICAgbWVzc2FnZSxcbiAgICAgICAgICAgICAgb3BlcmF0aW9uOiAnQUxURVInLFxuICAgICAgICAgICAgICB0eXBlOiBkaWZmLnJocyxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgbmV4dCgpO1xuICAgICAgICAgIH0gZWxzZSBpZiAoZGlmZi5saHMgPT09ICdpbnQnICYmIGRpZmYucmhzID09PSAndmFyaW50Jykge1xuICAgICAgICAgICAgLy8gYWx0ZXIgZmllbGQgdHlwZSBwb3NzaWJsZVxuICAgICAgICAgICAgY29uc3QgbWVzc2FnZSA9IHV0aWwuZm9ybWF0KFxuICAgICAgICAgICAgICAnU2NoZW1hIGZvciB0YWJsZSBcIiVzXCIgaGFzIG5ldyB0eXBlIGZvciBmaWVsZCBcIiVzXCIsIGFyZSB5b3Ugc3VyZSB5b3Ugd2FudCB0byBhbHRlciB0byB1cGRhdGUgdGhlIGZpZWxkIHR5cGU/JyxcbiAgICAgICAgICAgICAgdGFibGVOYW1lLFxuICAgICAgICAgICAgICBmaWVsZE5hbWUsXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgYWx0ZXJPcGVyYXRpb25zLnB1c2goe1xuICAgICAgICAgICAgICBmaWVsZE5hbWUsXG4gICAgICAgICAgICAgIG1lc3NhZ2UsXG4gICAgICAgICAgICAgIG9wZXJhdGlvbjogJ0FMVEVSJyxcbiAgICAgICAgICAgICAgdHlwZTogZGlmZi5yaHMsXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIG5leHQoKTtcbiAgICAgICAgICB9IGVsc2UgaWYgKGRpZmYubGhzID09PSAndGltZXV1aWQnICYmIGRpZmYucmhzID09PSAndXVpZCcpIHtcbiAgICAgICAgICAgIC8vIGFsdGVyIGZpZWxkIHR5cGUgcG9zc2libGVcbiAgICAgICAgICAgIGNvbnN0IG1lc3NhZ2UgPSB1dGlsLmZvcm1hdChcbiAgICAgICAgICAgICAgJ1NjaGVtYSBmb3IgdGFibGUgXCIlc1wiIGhhcyBuZXcgdHlwZSBmb3IgZmllbGQgXCIlc1wiLCBhcmUgeW91IHN1cmUgeW91IHdhbnQgdG8gYWx0ZXIgdG8gdXBkYXRlIHRoZSBmaWVsZCB0eXBlPycsXG4gICAgICAgICAgICAgIHRhYmxlTmFtZSxcbiAgICAgICAgICAgICAgZmllbGROYW1lLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIGFsdGVyT3BlcmF0aW9ucy5wdXNoKHtcbiAgICAgICAgICAgICAgZmllbGROYW1lLFxuICAgICAgICAgICAgICBtZXNzYWdlLFxuICAgICAgICAgICAgICBvcGVyYXRpb246ICdBTFRFUicsXG4gICAgICAgICAgICAgIHR5cGU6IGRpZmYucmhzLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICBuZXh0KCk7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIC8vIGFsdGVyIHR5cGUgaW1wb3NzaWJsZVxuICAgICAgICAgICAgY29uc3QgbWVzc2FnZSA9IHV0aWwuZm9ybWF0KFxuICAgICAgICAgICAgICAnU2NoZW1hIGZvciB0YWJsZSBcIiVzXCIgaGFzIG5ldyB0eXBlIGZvciBmaWVsZCBcIiVzXCIsIGFsbCBkYXRhIGluIHRoZSBmaWVsZCB3aWxsIGJlIGxvc3QsIGFyZSB5b3Ugc3VyZSB5b3Ugd2FudCB0byBkcm9wIHRoZSBmaWVsZCAmIHJlY3JlYXRlIGl0PycsXG4gICAgICAgICAgICAgIHRhYmxlTmFtZSxcbiAgICAgICAgICAgICAgZmllbGROYW1lLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIGFsdGVyT3BlcmF0aW9ucy5wdXNoKHtcbiAgICAgICAgICAgICAgZmllbGROYW1lLFxuICAgICAgICAgICAgICBtZXNzYWdlLFxuICAgICAgICAgICAgICBvcGVyYXRpb246ICdEUk9QJyxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgYWx0ZXJPcGVyYXRpb25zLnB1c2goe1xuICAgICAgICAgICAgICBmaWVsZE5hbWUsXG4gICAgICAgICAgICAgIG9wZXJhdGlvbjogJ0FERCcsXG4gICAgICAgICAgICAgIHR5cGU6IHBhcnNlci5leHRyYWN0X2FsdGVyZWRfdHlwZShub3JtYWxpemVkTW9kZWxTY2hlbWEsIGRpZmYpLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICBkcm9wcGVkRmllbGRzID0gdHJ1ZTtcbiAgICAgICAgICAgIG5vcm1hbGl6ZXIucmVtb3ZlX2RlcGVuZGVudF92aWV3c19mcm9tX25vcm1hbGl6ZWRfc2NoZW1hKG5vcm1hbGl6ZWREQlNjaGVtYSwgZGJTY2hlbWEsIGZpZWxkTmFtZSk7XG4gICAgICAgICAgICBuZXh0KCk7XG4gICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIC8vIGFsdGVyIHR5cGUgaW1wb3NzaWJsZVxuICAgICAgICAgIGNvbnN0IG1lc3NhZ2UgPSB1dGlsLmZvcm1hdChcbiAgICAgICAgICAgICdTY2hlbWEgZm9yIHRhYmxlIFwiJXNcIiBoYXMgbmV3IHR5cGUgZm9yIGZpZWxkIFwiJXNcIiwgYWxsIGRhdGEgaW4gdGhlIGZpZWxkIHdpbGwgYmUgbG9zdCwgYXJlIHlvdSBzdXJlIHlvdSB3YW50IHRvIGRyb3AgdGhlIGZpZWxkICYgcmVjcmVhdGUgaXQ/JyxcbiAgICAgICAgICAgIHRhYmxlTmFtZSxcbiAgICAgICAgICAgIGZpZWxkTmFtZSxcbiAgICAgICAgICApO1xuICAgICAgICAgIGFsdGVyT3BlcmF0aW9ucy5wdXNoKHtcbiAgICAgICAgICAgIGZpZWxkTmFtZSxcbiAgICAgICAgICAgIG1lc3NhZ2UsXG4gICAgICAgICAgICBvcGVyYXRpb246ICdEUk9QJyxcbiAgICAgICAgICB9KTtcbiAgICAgICAgICBhbHRlck9wZXJhdGlvbnMucHVzaCh7XG4gICAgICAgICAgICBmaWVsZE5hbWUsXG4gICAgICAgICAgICBvcGVyYXRpb246ICdBREQnLFxuICAgICAgICAgICAgdHlwZTogcGFyc2VyLmV4dHJhY3RfYWx0ZXJlZF90eXBlKG5vcm1hbGl6ZWRNb2RlbFNjaGVtYSwgZGlmZiksXG4gICAgICAgICAgfSk7XG4gICAgICAgICAgZHJvcHBlZEZpZWxkcyA9IHRydWU7XG4gICAgICAgICAgbm9ybWFsaXplci5yZW1vdmVfZGVwZW5kZW50X3ZpZXdzX2Zyb21fbm9ybWFsaXplZF9zY2hlbWEobm9ybWFsaXplZERCU2NoZW1hLCBkYlNjaGVtYSwgZmllbGROYW1lKTtcbiAgICAgICAgICBuZXh0KCk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBuZXh0KCk7XG4gICAgfSwgKGVycikgPT4ge1xuICAgICAgaWYgKGVycikge1xuICAgICAgICBjYWxsYmFjayhlcnIpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBpZiAoZHJvcHBlZEZpZWxkcyAmJiB0aGlzLl9lc19idWlsZGVyKSB7XG4gICAgICAgIGNvbnN0IGluZGV4TmFtZSA9IGAke3Byb3BlcnRpZXMua2V5c3BhY2V9XyR7cHJvcGVydGllcy50YWJsZV9uYW1lfWA7XG4gICAgICAgIHRoaXMuX2VzX2J1aWxkZXIuZGVsZXRlX2luZGV4KGluZGV4TmFtZSwgKCkgPT4ge1xuICAgICAgICAgIHRoaXMuX2FwcGx5X2FsdGVyX29wZXJhdGlvbnMoYWx0ZXJPcGVyYXRpb25zLCBkYlNjaGVtYSwgbm9ybWFsaXplZE1vZGVsU2NoZW1hLCBub3JtYWxpemVkREJTY2hlbWEsIGNhbGxiYWNrKTtcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIHRoaXMuX2FwcGx5X2FsdGVyX29wZXJhdGlvbnMoYWx0ZXJPcGVyYXRpb25zLCBkYlNjaGVtYSwgbm9ybWFsaXplZE1vZGVsU2NoZW1hLCBub3JtYWxpemVkREJTY2hlbWEsIGNhbGxiYWNrKTtcbiAgICB9KTtcbiAgfSxcbn07XG5cbm1vZHVsZS5leHBvcnRzID0gVGFibGVCdWlsZGVyO1xuIl19