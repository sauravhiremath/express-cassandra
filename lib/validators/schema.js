'use strict';

var _ = require('lodash');
var util = require('util');

var datatypes = require('./datatypes');

var schemer = {
  validate_table_name(tableName) {
    return typeof tableName === 'string' && /^[a-zA-Z]+[a-zA-Z0-9_]*/.test(tableName);
  },
  has_field(modelSchema, fieldName) {
    var optionFieldNames = [];
    if (modelSchema.options) {
      if (modelSchema.options.timestamps) {
        var timestampOptions = {
          createdAt: modelSchema.options.timestamps.createdAt || 'createdAt',
          updatedAt: modelSchema.options.timestamps.updatedAt || 'updatedAt'
        };
        optionFieldNames.push(timestampOptions.createdAt);
        optionFieldNames.push(timestampOptions.updatedAt);
      }

      if (modelSchema.options.versions) {
        var versionOptions = {
          key: modelSchema.options.versions.key || '__v'
        };
        optionFieldNames.push(versionOptions.key);
      }
    }
    return _.has(modelSchema.fields, fieldName) || optionFieldNames.includes(fieldName);
  },
  validate_field(modelSchema, fieldObject, fieldName) {
    if (!fieldObject) {
      throw new Error(util.format('Schema field "%s" is not properly defined', fieldName));
    }
    var fieldtype = this.get_field_type(modelSchema, fieldName);
    if (!_.has(datatypes, fieldtype)) {
      throw new Error(util.format('Invalid field type "%s" for field: %s', fieldtype, fieldName));
    }
    if (['map', 'list', 'set', 'frozen'].includes(fieldtype)) {
      if (!fieldObject.typeDef) {
        throw new Error(util.format('Missing typeDef for field type "%s" on field: %s', fieldtype, fieldName));
      }
      if (typeof fieldObject.typeDef !== 'string') {
        throw new Error(util.format('Invalid typeDef for field type "%s" on field: %s', fieldtype, fieldName));
      }
    }
    if (!this.is_field_default_value_valid(modelSchema, fieldName)) {
      throw new Error(util.format('Invalid default value for field: %s(%s)', fieldName, fieldtype));
    }
  },

  validate_primary_key(modelSchema) {
    var _this = this;

    if (typeof modelSchema.key[0] === 'string') {
      if (!this.has_field(modelSchema, modelSchema.key[0])) {
        throw new Error('Partition Key must also be a valid field name');
      }
      if (modelSchema.fields[modelSchema.key[0]] && modelSchema.fields[modelSchema.key[0]].virtual) {
        throw new Error("Partition Key must also be a db field name, can't be a virtual field name");
      }
    } else if (_.isArray(modelSchema.key[0])) {
      if (modelSchema.key[0].length === 0) {
        throw new Error("Partition Key array can't be empty");
      }
      modelSchema.key[0].forEach(function (partitionKeyField) {
        if (typeof partitionKeyField !== 'string' || !_this.has_field(modelSchema, partitionKeyField)) {
          throw new Error('Partition Key array must contain only valid field names');
        }
        if (modelSchema.fields[partitionKeyField] && modelSchema.fields[partitionKeyField].virtual) {
          throw new Error("Partition Key array must contain only db field names, can't contain virtual field names");
        }
      });
    } else {
      throw new Error('Partition Key must be a field name string, or array of field names');
    }

    modelSchema.key.forEach(function (primaryKeyField, primaryKeyIndex) {
      if (primaryKeyIndex > 0) {
        if (typeof primaryKeyField !== 'string' || !_this.has_field(modelSchema, primaryKeyField)) {
          throw new Error('Clustering Keys must be valid field names');
        }
        if (modelSchema.fields[primaryKeyField] && modelSchema.fields[primaryKeyField].virtual) {
          throw new Error("Clustering Keys must be db field names, can't be virtual field names");
        }
      }
    });

    if (modelSchema.clustering_order) {
      if (!_.isPlainObject(modelSchema.clustering_order)) {
        throw new Error('clustering_order must be an object of clustering_key attributes');
      }

      _.forEach(modelSchema.clustering_order, function (clusteringOrder, clusteringFieldName) {
        if (!['asc', 'desc'].includes(clusteringOrder.toLowerCase())) {
          throw new Error('clustering_order attribute values can only be ASC or DESC');
        }
        if (modelSchema.key.indexOf(clusteringFieldName) < 1) {
          throw new Error('clustering_order field attributes must be clustering keys only');
        }
      });
    }
  },

  validate_materialized_view(modelSchema, materializedViewObject, materializedViewName) {
    var _this2 = this;

    if (!_.isPlainObject(materializedViewObject)) {
      throw new Error(util.format('attribute "%s" under materialized_views must be an object', materializedViewName));
    }

    if (!materializedViewObject.select || !materializedViewObject.key) {
      throw new Error(util.format('materialized_view "%s" must have "select" and "key" attributes', materializedViewName));
    }

    if (!_.isArray(materializedViewObject.select) || !_.isArray(materializedViewObject.key)) {
      throw new Error(util.format('"select" and "key" attributes must be an array under attribute %s of materialized_views', materializedViewName));
    }

    materializedViewObject.select.forEach(function (materializedViewSelectField) {
      if (typeof materializedViewSelectField !== 'string' || !(_this2.has_field(modelSchema, materializedViewSelectField) || materializedViewSelectField === '*')) {
        throw new Error(util.format('the select attribute under materialized_view %s must be an array of field name strings or ["*"]', materializedViewName));
      }

      if (modelSchema.fields[materializedViewSelectField] && modelSchema.fields[materializedViewSelectField].virtual) {
        throw new Error(util.format('the select attribute under %s of materialized_views must be an array of db field names, ' + 'cannot contain any virtual field name', materializedViewName));
      }
    });

    // validate materialized_view primary key
    if (typeof materializedViewObject.key[0] === 'string') {
      if (!this.has_field(modelSchema, materializedViewObject.key[0])) {
        throw new Error(util.format('materialized_view %s: partition key string must match a valid field name', materializedViewName));
      }
      if (modelSchema.fields[materializedViewObject.key[0]] && modelSchema.fields[materializedViewObject.key[0]].virtual) {
        throw new Error(util.format('materialized_view %s: partition key must match a db field name, cannot be a virtual field name', materializedViewName));
      }
    } else if (_.isArray(materializedViewObject.key[0])) {
      if (materializedViewObject.key[0].length === 0) {
        throw new Error(util.format('materialized_view %s: partition key array cannot be empty', materializedViewName));
      }
      materializedViewObject.key[0].forEach(function (materializedViewPartitionKeyField) {
        if (typeof materializedViewPartitionKeyField !== 'string' || !_this2.has_field(modelSchema, materializedViewPartitionKeyField)) {
          throw new Error(util.format('materialized_view %s: partition key array must contain only valid field names', materializedViewName));
        }
        if (modelSchema.fields[materializedViewPartitionKeyField] && modelSchema.fields[materializedViewPartitionKeyField].virtual) {
          throw new Error(util.format('materialized_view %s: partition key array must contain only db field names, ' + 'cannot contain virtual field names', materializedViewName));
        }
      });
    } else {
      throw new Error(util.format('materialized_view %s: partition key must be a field name string, or array of field names', materializedViewName));
    }

    materializedViewObject.key.forEach(function (materializedViewPrimaryKeyField, materializedViewPrimaryKeyIndex) {
      if (materializedViewPrimaryKeyIndex > 0) {
        if (typeof materializedViewPrimaryKeyField !== 'string' || !_this2.has_field(modelSchema, materializedViewPrimaryKeyField)) {
          throw new Error(util.format('materialized_view %s: clustering keys must be valid field names', materializedViewName));
        }
        if (modelSchema.fields[materializedViewPrimaryKeyField] && modelSchema.fields[materializedViewPrimaryKeyField].virtual) {
          throw new Error(util.format('materialized_view %s: clustering keys must be db field names, cannot contain virtual fields', materializedViewName));
        }
      }
    });

    if (materializedViewObject.clustering_order) {
      if (!_.isPlainObject(materializedViewObject.clustering_order)) {
        throw new Error(util.format('materialized_view %s: clustering_order must be an object of clustering_key attributes', materializedViewName));
      }

      _.forEach(materializedViewObject.clustering_order, function (mvClusteringOrder, mvlusteringFieldName) {
        if (!['asc', 'desc'].includes(mvClusteringOrder.toLowerCase())) {
          throw new Error(util.format('materialized_view %s: clustering_order attribute values can only be ASC or DESC', materializedViewName));
        }
        if (materializedViewObject.key.indexOf(mvlusteringFieldName) < 1) {
          throw new Error(util.format('materialized_view %s: clustering_order field attributes must be clustering keys only', materializedViewName));
        }
      });
    }
  },

  validate_index(modelSchema, indexDef) {
    if (typeof indexDef !== 'string') {
      throw new Error('indexes must be an array of strings');
    }

    var indexNameList = indexDef.replace(/["\s]/g, '').split(/[()]/g);
    if (indexNameList.length > 1) {
      indexNameList[0] = indexNameList[0].toLowerCase();
      if (!['entries', 'keys', 'values', 'full'].includes(indexNameList[0])) {
        throw new Error(util.format('index "%s" is not defined properly', indexDef));
      }
      if (!this.has_field(modelSchema, indexNameList[1])) {
        throw new Error(util.format('"%s" is not a valid field name, indexes must be defined on field names', indexNameList[1]));
      }
      if (modelSchema.fields[indexNameList[1]] && modelSchema.fields[indexNameList[1]].virtual) {
        throw new Error("indexes must be an array of db field names, can't contain virtual fields");
      }
    } else {
      if (!this.has_field(modelSchema, indexNameList[0])) {
        throw new Error(util.format('"%s" is not a valid field, indexes must be defined on field names', indexNameList[0]));
      }
      if (modelSchema.fields[indexNameList[0]] && modelSchema.fields[indexNameList[0]].virtual) {
        throw new Error("indexes must be an array of db field names, can't contain virtual fields");
      }
    }
  },

  validate_custom_index(modelSchema, customIndex) {
    if (!_.isPlainObject(customIndex)) {
      throw new Error('custom_index must be an object with proper indexing attributes');
    }
    if (typeof customIndex.on !== 'string' || !this.has_field(modelSchema, customIndex.on)) {
      throw new Error("custom_index must have an 'on' attribute with string value and value must be a valid field name");
    }
    if (modelSchema.fields[customIndex.on] && modelSchema.fields[customIndex.on].virtual) {
      throw new Error("custom_index 'on' attribute must be a db field name, can't contain virtual fields");
    }
    if (typeof customIndex.using !== 'string') {
      throw new Error("custom_index must have a 'using' attribute with string value");
    }
    if (!_.isPlainObject(customIndex.options)) {
      throw new Error('custom_index must have an "options" attribute and it must be an object, ' + 'pass blank {} object if no options are required');
    }
  },

  validate_model_schema(modelSchema) {
    var _this3 = this;

    if (!modelSchema) {
      throw new Error('A schema must be specified');
    }

    if (!_.isPlainObject(modelSchema.fields) || Object.keys(modelSchema.fields).length === 0) {
      throw new Error('Schema must contain a non-empty "fields" map object');
    }

    if (!modelSchema.key || !_.isArray(modelSchema.key)) {
      throw new Error('Schema must contain "key" in the form: [ [partitionkey1, ...], clusteringkey1, ...]');
    }

    _.forEach(modelSchema.fields, function (fieldObject, fieldName) {
      _this3.validate_field(modelSchema, fieldObject, fieldName);
    });

    this.validate_primary_key(modelSchema);

    if (modelSchema.materialized_views) {
      if (!_.isPlainObject(modelSchema.materialized_views)) {
        throw new Error('materialized_views must be an object with view names as attributes');
      }
      _.forEach(modelSchema.materialized_views, function (materializedViewObject, materializedViewName) {
        _this3.validate_materialized_view(modelSchema, materializedViewObject, materializedViewName);
      });
    }

    if (modelSchema.indexes) {
      if (!_.isArray(modelSchema.indexes)) {
        throw new Error('indexes must be an array of field name strings');
      }

      modelSchema.indexes.forEach(function (indexDef) {
        _this3.validate_index(modelSchema, indexDef);
      });
    }

    if (modelSchema.custom_index && modelSchema.custom_indexes) {
      throw new Error('both custom_index and custom_indexes are defined in schema, only one of them should be defined');
    }

    if (modelSchema.custom_index) {
      this.validate_custom_index(modelSchema, modelSchema.custom_index);
    }

    if (modelSchema.custom_indexes) {
      if (!_.isArray(modelSchema.custom_indexes)) {
        throw new Error('custom_indexes must be an array with objects with proper indexing attributes');
      }
      modelSchema.custom_indexes.forEach(function (customIndex) {
        _this3.validate_custom_index(modelSchema, customIndex);
      });
    }
  },

  format_validation_rule(rule, fieldname) {
    if (!_.isPlainObject(rule)) {
      throw new Error(util.format('Validation rule for "%s" must be a function or an object', fieldname));
    }
    if (typeof rule.validator !== 'function') {
      throw new Error(util.format('Rule validator for "%s" must be a valid function', fieldname));
    }
    if (!rule.message) {
      rule.message = this.get_generic_validation_message;
    }
    if (typeof rule.message === 'string') {
      rule.message = function f1(message) {
        return util.format(message);
      }.bind(null, rule.message);
    }
    if (typeof rule.message !== 'function') {
      throw new Error(util.format('Invalid validator message for "%s", must be string or a function', fieldname));
    }
    return rule;
  },

  get_generic_validation_message(value, propName, fieldtype) {
    return util.format('Invalid Value: "%s" for Field: %s (Type: %s)', value, propName, fieldtype);
  },

  get_validation_message(validators, value) {
    if (value == null || _.isPlainObject(value) && value.$db_function) {
      return true;
    }

    for (var v = 0; v < validators.length; v++) {
      if (typeof validators[v].validator === 'function') {
        if (!validators[v].validator(value)) {
          return validators[v].message;
        }
      }
    }
    return true;
  },

  get_validators(modelSchema, fieldname) {
    var _this4 = this;

    var validators = [];
    var fieldtype = this.get_field_type(modelSchema, fieldname);
    var typeFieldValidator = datatypes.generic_type_validator(fieldtype);

    if (typeFieldValidator) {
      validators.push(typeFieldValidator);
    }

    var field = modelSchema.fields[fieldname];
    if (typeof field.rule !== 'undefined') {
      if (typeof field.rule === 'function') {
        field.rule = {
          validator: field.rule,
          message: this.get_generic_validation_message
        };
        validators.push(field.rule);
      } else if (Array.isArray(field.rule.validators)) {
        field.rule.validators.forEach(function (fieldrule) {
          validators.push(_this4.format_validation_rule(fieldrule, fieldname));
        });
      } else if (field.rule.validator) {
        validators.push(this.format_validation_rule(field.rule, fieldname));
      }
    }

    return validators;
  },

  get_field_type(modelSchema, fieldName) {
    var fieldObject = modelSchema.fields[fieldName];

    if (typeof fieldObject === 'string') {
      return fieldObject;
    }
    if (_.isPlainObject(fieldObject)) {
      return fieldObject.type;
    }
    throw new Error(`Type of field "${fieldName}" not defined properly`);
  },

  is_required_field(modelSchema, fieldName) {
    if (modelSchema.fields[fieldName].rule && modelSchema.fields[fieldName].rule.required) {
      return true;
    }
    return false;
  },

  is_primary_key_field(modelSchema, fieldName) {
    if (modelSchema.key.includes(fieldName)) {
      return true;
    }
    if (modelSchema.key[0] instanceof Array && modelSchema.key[0].includes(fieldName)) {
      return true;
    }
    return false;
  },

  is_field_default_value_valid(modelSchema, fieldName) {
    if (_.isPlainObject(modelSchema.fields[fieldName]) && modelSchema.fields[fieldName].default) {
      if (_.isPlainObject(modelSchema.fields[fieldName].default) && !modelSchema.fields[fieldName].default.$db_function) {
        return ['map', 'list', 'set', 'frozen'].includes(modelSchema.fields[fieldName].type);
      }
      return true;
    }
    return true;
  }

};

module.exports = schemer;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy92YWxpZGF0b3JzL3NjaGVtYS5qcyJdLCJuYW1lcyI6WyJfIiwicmVxdWlyZSIsInV0aWwiLCJkYXRhdHlwZXMiLCJzY2hlbWVyIiwidmFsaWRhdGVfdGFibGVfbmFtZSIsInRhYmxlTmFtZSIsInRlc3QiLCJoYXNfZmllbGQiLCJtb2RlbFNjaGVtYSIsImZpZWxkTmFtZSIsIm9wdGlvbkZpZWxkTmFtZXMiLCJvcHRpb25zIiwidGltZXN0YW1wcyIsInRpbWVzdGFtcE9wdGlvbnMiLCJjcmVhdGVkQXQiLCJ1cGRhdGVkQXQiLCJwdXNoIiwidmVyc2lvbnMiLCJ2ZXJzaW9uT3B0aW9ucyIsImtleSIsImhhcyIsImZpZWxkcyIsImluY2x1ZGVzIiwidmFsaWRhdGVfZmllbGQiLCJmaWVsZE9iamVjdCIsIkVycm9yIiwiZm9ybWF0IiwiZmllbGR0eXBlIiwiZ2V0X2ZpZWxkX3R5cGUiLCJ0eXBlRGVmIiwiaXNfZmllbGRfZGVmYXVsdF92YWx1ZV92YWxpZCIsInZhbGlkYXRlX3ByaW1hcnlfa2V5IiwidmlydHVhbCIsImlzQXJyYXkiLCJsZW5ndGgiLCJmb3JFYWNoIiwicGFydGl0aW9uS2V5RmllbGQiLCJwcmltYXJ5S2V5RmllbGQiLCJwcmltYXJ5S2V5SW5kZXgiLCJjbHVzdGVyaW5nX29yZGVyIiwiaXNQbGFpbk9iamVjdCIsImNsdXN0ZXJpbmdPcmRlciIsImNsdXN0ZXJpbmdGaWVsZE5hbWUiLCJ0b0xvd2VyQ2FzZSIsImluZGV4T2YiLCJ2YWxpZGF0ZV9tYXRlcmlhbGl6ZWRfdmlldyIsIm1hdGVyaWFsaXplZFZpZXdPYmplY3QiLCJtYXRlcmlhbGl6ZWRWaWV3TmFtZSIsInNlbGVjdCIsIm1hdGVyaWFsaXplZFZpZXdTZWxlY3RGaWVsZCIsIm1hdGVyaWFsaXplZFZpZXdQYXJ0aXRpb25LZXlGaWVsZCIsIm1hdGVyaWFsaXplZFZpZXdQcmltYXJ5S2V5RmllbGQiLCJtYXRlcmlhbGl6ZWRWaWV3UHJpbWFyeUtleUluZGV4IiwibXZDbHVzdGVyaW5nT3JkZXIiLCJtdmx1c3RlcmluZ0ZpZWxkTmFtZSIsInZhbGlkYXRlX2luZGV4IiwiaW5kZXhEZWYiLCJpbmRleE5hbWVMaXN0IiwicmVwbGFjZSIsInNwbGl0IiwidmFsaWRhdGVfY3VzdG9tX2luZGV4IiwiY3VzdG9tSW5kZXgiLCJvbiIsInVzaW5nIiwidmFsaWRhdGVfbW9kZWxfc2NoZW1hIiwiT2JqZWN0Iiwia2V5cyIsIm1hdGVyaWFsaXplZF92aWV3cyIsImluZGV4ZXMiLCJjdXN0b21faW5kZXgiLCJjdXN0b21faW5kZXhlcyIsImZvcm1hdF92YWxpZGF0aW9uX3J1bGUiLCJydWxlIiwiZmllbGRuYW1lIiwidmFsaWRhdG9yIiwibWVzc2FnZSIsImdldF9nZW5lcmljX3ZhbGlkYXRpb25fbWVzc2FnZSIsImYxIiwiYmluZCIsInZhbHVlIiwicHJvcE5hbWUiLCJnZXRfdmFsaWRhdGlvbl9tZXNzYWdlIiwidmFsaWRhdG9ycyIsIiRkYl9mdW5jdGlvbiIsInYiLCJnZXRfdmFsaWRhdG9ycyIsInR5cGVGaWVsZFZhbGlkYXRvciIsImdlbmVyaWNfdHlwZV92YWxpZGF0b3IiLCJmaWVsZCIsIkFycmF5IiwiZmllbGRydWxlIiwidHlwZSIsImlzX3JlcXVpcmVkX2ZpZWxkIiwicmVxdWlyZWQiLCJpc19wcmltYXJ5X2tleV9maWVsZCIsImRlZmF1bHQiLCJtb2R1bGUiLCJleHBvcnRzIl0sIm1hcHBpbmdzIjoiOztBQUFBLElBQU1BLElBQUlDLFFBQVEsUUFBUixDQUFWO0FBQ0EsSUFBTUMsT0FBT0QsUUFBUSxNQUFSLENBQWI7O0FBRUEsSUFBTUUsWUFBWUYsUUFBUSxhQUFSLENBQWxCOztBQUVBLElBQU1HLFVBQVU7QUFDZEMsc0JBQW9CQyxTQUFwQixFQUErQjtBQUM3QixXQUFRLE9BQU9BLFNBQVAsS0FBcUIsUUFBckIsSUFBaUMsMEJBQTBCQyxJQUExQixDQUErQkQsU0FBL0IsQ0FBekM7QUFDRCxHQUhhO0FBSWRFLFlBQVVDLFdBQVYsRUFBdUJDLFNBQXZCLEVBQWtDO0FBQ2hDLFFBQU1DLG1CQUFtQixFQUF6QjtBQUNBLFFBQUlGLFlBQVlHLE9BQWhCLEVBQXlCO0FBQ3ZCLFVBQUlILFlBQVlHLE9BQVosQ0FBb0JDLFVBQXhCLEVBQW9DO0FBQ2xDLFlBQU1DLG1CQUFtQjtBQUN2QkMscUJBQVdOLFlBQVlHLE9BQVosQ0FBb0JDLFVBQXBCLENBQStCRSxTQUEvQixJQUE0QyxXQURoQztBQUV2QkMscUJBQVdQLFlBQVlHLE9BQVosQ0FBb0JDLFVBQXBCLENBQStCRyxTQUEvQixJQUE0QztBQUZoQyxTQUF6QjtBQUlBTCx5QkFBaUJNLElBQWpCLENBQXNCSCxpQkFBaUJDLFNBQXZDO0FBQ0FKLHlCQUFpQk0sSUFBakIsQ0FBc0JILGlCQUFpQkUsU0FBdkM7QUFDRDs7QUFFRCxVQUFJUCxZQUFZRyxPQUFaLENBQW9CTSxRQUF4QixFQUFrQztBQUNoQyxZQUFNQyxpQkFBaUI7QUFDckJDLGVBQUtYLFlBQVlHLE9BQVosQ0FBb0JNLFFBQXBCLENBQTZCRSxHQUE3QixJQUFvQztBQURwQixTQUF2QjtBQUdBVCx5QkFBaUJNLElBQWpCLENBQXNCRSxlQUFlQyxHQUFyQztBQUNEO0FBQ0Y7QUFDRCxXQUFPcEIsRUFBRXFCLEdBQUYsQ0FBTVosWUFBWWEsTUFBbEIsRUFBMEJaLFNBQTFCLEtBQXdDQyxpQkFBaUJZLFFBQWpCLENBQTBCYixTQUExQixDQUEvQztBQUNELEdBeEJhO0FBeUJkYyxpQkFBZWYsV0FBZixFQUE0QmdCLFdBQTVCLEVBQXlDZixTQUF6QyxFQUFvRDtBQUNsRCxRQUFJLENBQUNlLFdBQUwsRUFBa0I7QUFDaEIsWUFBTyxJQUFJQyxLQUFKLENBQVV4QixLQUFLeUIsTUFBTCxDQUFZLDJDQUFaLEVBQXlEakIsU0FBekQsQ0FBVixDQUFQO0FBQ0Q7QUFDRCxRQUFNa0IsWUFBWSxLQUFLQyxjQUFMLENBQW9CcEIsV0FBcEIsRUFBaUNDLFNBQWpDLENBQWxCO0FBQ0EsUUFBSSxDQUFDVixFQUFFcUIsR0FBRixDQUFNbEIsU0FBTixFQUFpQnlCLFNBQWpCLENBQUwsRUFBa0M7QUFDaEMsWUFBTyxJQUFJRixLQUFKLENBQVV4QixLQUFLeUIsTUFBTCxDQUFZLHVDQUFaLEVBQXFEQyxTQUFyRCxFQUFnRWxCLFNBQWhFLENBQVYsQ0FBUDtBQUNEO0FBQ0QsUUFBSSxDQUFDLEtBQUQsRUFBUSxNQUFSLEVBQWdCLEtBQWhCLEVBQXVCLFFBQXZCLEVBQWlDYSxRQUFqQyxDQUEwQ0ssU0FBMUMsQ0FBSixFQUEwRDtBQUN4RCxVQUFJLENBQUNILFlBQVlLLE9BQWpCLEVBQTBCO0FBQ3hCLGNBQU8sSUFBSUosS0FBSixDQUFVeEIsS0FBS3lCLE1BQUwsQ0FBWSxrREFBWixFQUFnRUMsU0FBaEUsRUFBMkVsQixTQUEzRSxDQUFWLENBQVA7QUFDRDtBQUNELFVBQUksT0FBT2UsWUFBWUssT0FBbkIsS0FBK0IsUUFBbkMsRUFBNkM7QUFDM0MsY0FBTyxJQUFJSixLQUFKLENBQVV4QixLQUFLeUIsTUFBTCxDQUFZLGtEQUFaLEVBQWdFQyxTQUFoRSxFQUEyRWxCLFNBQTNFLENBQVYsQ0FBUDtBQUNEO0FBQ0Y7QUFDRCxRQUFJLENBQUUsS0FBS3FCLDRCQUFMLENBQWtDdEIsV0FBbEMsRUFBK0NDLFNBQS9DLENBQU4sRUFBa0U7QUFDaEUsWUFBTyxJQUFJZ0IsS0FBSixDQUFVeEIsS0FBS3lCLE1BQUwsQ0FBWSx5Q0FBWixFQUF1RGpCLFNBQXZELEVBQWtFa0IsU0FBbEUsQ0FBVixDQUFQO0FBQ0Q7QUFDRixHQTVDYTs7QUE4Q2RJLHVCQUFxQnZCLFdBQXJCLEVBQWtDO0FBQUE7O0FBQ2hDLFFBQUksT0FBUUEsWUFBWVcsR0FBWixDQUFnQixDQUFoQixDQUFSLEtBQWdDLFFBQXBDLEVBQThDO0FBQzVDLFVBQUksQ0FBQyxLQUFLWixTQUFMLENBQWVDLFdBQWYsRUFBNEJBLFlBQVlXLEdBQVosQ0FBZ0IsQ0FBaEIsQ0FBNUIsQ0FBTCxFQUFzRDtBQUNwRCxjQUFPLElBQUlNLEtBQUosQ0FBVSwrQ0FBVixDQUFQO0FBQ0Q7QUFDRCxVQUFJakIsWUFBWWEsTUFBWixDQUFtQmIsWUFBWVcsR0FBWixDQUFnQixDQUFoQixDQUFuQixLQUEwQ1gsWUFBWWEsTUFBWixDQUFtQmIsWUFBWVcsR0FBWixDQUFnQixDQUFoQixDQUFuQixFQUF1Q2EsT0FBckYsRUFBOEY7QUFDNUYsY0FBTyxJQUFJUCxLQUFKLENBQVUsMkVBQVYsQ0FBUDtBQUNEO0FBQ0YsS0FQRCxNQU9PLElBQUkxQixFQUFFa0MsT0FBRixDQUFVekIsWUFBWVcsR0FBWixDQUFnQixDQUFoQixDQUFWLENBQUosRUFBbUM7QUFDeEMsVUFBSVgsWUFBWVcsR0FBWixDQUFnQixDQUFoQixFQUFtQmUsTUFBbkIsS0FBOEIsQ0FBbEMsRUFBcUM7QUFDbkMsY0FBTyxJQUFJVCxLQUFKLENBQVUsb0NBQVYsQ0FBUDtBQUNEO0FBQ0RqQixrQkFBWVcsR0FBWixDQUFnQixDQUFoQixFQUFtQmdCLE9BQW5CLENBQTJCLFVBQUNDLGlCQUFELEVBQXVCO0FBQ2hELFlBQUssT0FBUUEsaUJBQVIsS0FBK0IsUUFBaEMsSUFBNkMsQ0FBQyxNQUFLN0IsU0FBTCxDQUFlQyxXQUFmLEVBQTRCNEIsaUJBQTVCLENBQWxELEVBQWtHO0FBQ2hHLGdCQUFPLElBQUlYLEtBQUosQ0FBVSx5REFBVixDQUFQO0FBQ0Q7QUFDRCxZQUFJakIsWUFBWWEsTUFBWixDQUFtQmUsaUJBQW5CLEtBQXlDNUIsWUFBWWEsTUFBWixDQUFtQmUsaUJBQW5CLEVBQXNDSixPQUFuRixFQUE0RjtBQUMxRixnQkFBTyxJQUFJUCxLQUFKLENBQVUseUZBQVYsQ0FBUDtBQUNEO0FBQ0YsT0FQRDtBQVFELEtBWk0sTUFZQTtBQUNMLFlBQU8sSUFBSUEsS0FBSixDQUFVLG9FQUFWLENBQVA7QUFDRDs7QUFFRGpCLGdCQUFZVyxHQUFaLENBQWdCZ0IsT0FBaEIsQ0FBd0IsVUFBQ0UsZUFBRCxFQUFrQkMsZUFBbEIsRUFBc0M7QUFDNUQsVUFBSUEsa0JBQWtCLENBQXRCLEVBQXlCO0FBQ3ZCLFlBQUssT0FBUUQsZUFBUixLQUE2QixRQUE5QixJQUEyQyxDQUFDLE1BQUs5QixTQUFMLENBQWVDLFdBQWYsRUFBNEI2QixlQUE1QixDQUFoRCxFQUE4RjtBQUM1RixnQkFBTyxJQUFJWixLQUFKLENBQVUsMkNBQVYsQ0FBUDtBQUNEO0FBQ0QsWUFBSWpCLFlBQVlhLE1BQVosQ0FBbUJnQixlQUFuQixLQUF1QzdCLFlBQVlhLE1BQVosQ0FBbUJnQixlQUFuQixFQUFvQ0wsT0FBL0UsRUFBd0Y7QUFDdEYsZ0JBQU8sSUFBSVAsS0FBSixDQUFVLHNFQUFWLENBQVA7QUFDRDtBQUNGO0FBQ0YsS0FURDs7QUFXQSxRQUFJakIsWUFBWStCLGdCQUFoQixFQUFrQztBQUNoQyxVQUFJLENBQUN4QyxFQUFFeUMsYUFBRixDQUFnQmhDLFlBQVkrQixnQkFBNUIsQ0FBTCxFQUFvRDtBQUNsRCxjQUFPLElBQUlkLEtBQUosQ0FBVSxpRUFBVixDQUFQO0FBQ0Q7O0FBRUQxQixRQUFFb0MsT0FBRixDQUFVM0IsWUFBWStCLGdCQUF0QixFQUF3QyxVQUFDRSxlQUFELEVBQWtCQyxtQkFBbEIsRUFBMEM7QUFDaEYsWUFBSSxDQUFDLENBQUMsS0FBRCxFQUFRLE1BQVIsRUFBZ0JwQixRQUFoQixDQUF5Qm1CLGdCQUFnQkUsV0FBaEIsRUFBekIsQ0FBTCxFQUE4RDtBQUM1RCxnQkFBTyxJQUFJbEIsS0FBSixDQUFVLDJEQUFWLENBQVA7QUFDRDtBQUNELFlBQUlqQixZQUFZVyxHQUFaLENBQWdCeUIsT0FBaEIsQ0FBd0JGLG1CQUF4QixJQUErQyxDQUFuRCxFQUFzRDtBQUNwRCxnQkFBTyxJQUFJakIsS0FBSixDQUFVLGdFQUFWLENBQVA7QUFDRDtBQUNGLE9BUEQ7QUFRRDtBQUNGLEdBL0ZhOztBQWlHZG9CLDZCQUEyQnJDLFdBQTNCLEVBQXdDc0Msc0JBQXhDLEVBQWdFQyxvQkFBaEUsRUFBc0Y7QUFBQTs7QUFDcEYsUUFBSSxDQUFDaEQsRUFBRXlDLGFBQUYsQ0FBZ0JNLHNCQUFoQixDQUFMLEVBQThDO0FBQzVDLFlBQU8sSUFBSXJCLEtBQUosQ0FBVXhCLEtBQUt5QixNQUFMLENBQVksMkRBQVosRUFBeUVxQixvQkFBekUsQ0FBVixDQUFQO0FBQ0Q7O0FBRUQsUUFBSSxDQUFDRCx1QkFBdUJFLE1BQXhCLElBQWtDLENBQUNGLHVCQUF1QjNCLEdBQTlELEVBQW1FO0FBQ2pFLFlBQU8sSUFBSU0sS0FBSixDQUFVeEIsS0FBS3lCLE1BQUwsQ0FBWSxnRUFBWixFQUE4RXFCLG9CQUE5RSxDQUFWLENBQVA7QUFDRDs7QUFFRCxRQUFJLENBQUNoRCxFQUFFa0MsT0FBRixDQUFVYSx1QkFBdUJFLE1BQWpDLENBQUQsSUFBNkMsQ0FBQ2pELEVBQUVrQyxPQUFGLENBQVVhLHVCQUF1QjNCLEdBQWpDLENBQWxELEVBQXlGO0FBQ3ZGLFlBQU8sSUFBSU0sS0FBSixDQUFVeEIsS0FBS3lCLE1BQUwsQ0FBWSx5RkFBWixFQUF1R3FCLG9CQUF2RyxDQUFWLENBQVA7QUFDRDs7QUFFREQsMkJBQXVCRSxNQUF2QixDQUE4QmIsT0FBOUIsQ0FBc0MsVUFBQ2MsMkJBQUQsRUFBaUM7QUFDckUsVUFBSyxPQUFRQSwyQkFBUixLQUF5QyxRQUExQyxJQUNLLEVBQUUsT0FBSzFDLFNBQUwsQ0FBZUMsV0FBZixFQUE0QnlDLDJCQUE1QixLQUNGQSxnQ0FBZ0MsR0FEaEMsQ0FEVCxFQUUrQztBQUM3QyxjQUFPLElBQUl4QixLQUFKLENBQVV4QixLQUFLeUIsTUFBTCxDQUNmLGlHQURlLEVBRWZxQixvQkFGZSxDQUFWLENBQVA7QUFJRDs7QUFFRCxVQUFJdkMsWUFBWWEsTUFBWixDQUFtQjRCLDJCQUFuQixLQUNHekMsWUFBWWEsTUFBWixDQUFtQjRCLDJCQUFuQixFQUFnRGpCLE9BRHZELEVBQ2dFO0FBQzlELGNBQU8sSUFBSVAsS0FBSixDQUFVeEIsS0FBS3lCLE1BQUwsQ0FDZiw2RkFDQSx1Q0FGZSxFQUdmcUIsb0JBSGUsQ0FBVixDQUFQO0FBS0Q7QUFDRixLQWxCRDs7QUFvQkE7QUFDQSxRQUFJLE9BQVFELHVCQUF1QjNCLEdBQXZCLENBQTJCLENBQTNCLENBQVIsS0FBMkMsUUFBL0MsRUFBeUQ7QUFDdkQsVUFBSSxDQUFDLEtBQUtaLFNBQUwsQ0FBZUMsV0FBZixFQUE0QnNDLHVCQUF1QjNCLEdBQXZCLENBQTJCLENBQTNCLENBQTVCLENBQUwsRUFBaUU7QUFDL0QsY0FBTyxJQUFJTSxLQUFKLENBQVV4QixLQUFLeUIsTUFBTCxDQUFZLDBFQUFaLEVBQXdGcUIsb0JBQXhGLENBQVYsQ0FBUDtBQUNEO0FBQ0QsVUFBSXZDLFlBQVlhLE1BQVosQ0FBbUJ5Qix1QkFBdUIzQixHQUF2QixDQUEyQixDQUEzQixDQUFuQixLQUNDWCxZQUFZYSxNQUFaLENBQW1CeUIsdUJBQXVCM0IsR0FBdkIsQ0FBMkIsQ0FBM0IsQ0FBbkIsRUFBa0RhLE9BRHZELEVBQ2dFO0FBQzlELGNBQU8sSUFBSVAsS0FBSixDQUFVeEIsS0FBS3lCLE1BQUwsQ0FDZixnR0FEZSxFQUVmcUIsb0JBRmUsQ0FBVixDQUFQO0FBSUQ7QUFDRixLQVhELE1BV08sSUFBSWhELEVBQUVrQyxPQUFGLENBQVVhLHVCQUF1QjNCLEdBQXZCLENBQTJCLENBQTNCLENBQVYsQ0FBSixFQUE4QztBQUNuRCxVQUFJMkIsdUJBQXVCM0IsR0FBdkIsQ0FBMkIsQ0FBM0IsRUFBOEJlLE1BQTlCLEtBQXlDLENBQTdDLEVBQWdEO0FBQzlDLGNBQU8sSUFBSVQsS0FBSixDQUFVeEIsS0FBS3lCLE1BQUwsQ0FBWSwyREFBWixFQUF5RXFCLG9CQUF6RSxDQUFWLENBQVA7QUFDRDtBQUNERCw2QkFBdUIzQixHQUF2QixDQUEyQixDQUEzQixFQUE4QmdCLE9BQTlCLENBQXNDLFVBQUNlLGlDQUFELEVBQXVDO0FBQzNFLFlBQUssT0FBUUEsaUNBQVIsS0FBK0MsUUFBaEQsSUFDRyxDQUFDLE9BQUszQyxTQUFMLENBQWVDLFdBQWYsRUFBNEIwQyxpQ0FBNUIsQ0FEUixFQUN3RTtBQUN0RSxnQkFBTyxJQUFJekIsS0FBSixDQUFVeEIsS0FBS3lCLE1BQUwsQ0FDZiwrRUFEZSxFQUVmcUIsb0JBRmUsQ0FBVixDQUFQO0FBSUQ7QUFDRCxZQUFJdkMsWUFBWWEsTUFBWixDQUFtQjZCLGlDQUFuQixLQUNDMUMsWUFBWWEsTUFBWixDQUFtQjZCLGlDQUFuQixFQUFzRGxCLE9BRDNELEVBQ29FO0FBQ2xFLGdCQUFPLElBQUlQLEtBQUosQ0FBVXhCLEtBQUt5QixNQUFMLENBQ2YsaUZBQ0Esb0NBRmUsRUFHZnFCLG9CQUhlLENBQVYsQ0FBUDtBQUtEO0FBQ0YsT0FoQkQ7QUFpQkQsS0FyQk0sTUFxQkE7QUFDTCxZQUFPLElBQUl0QixLQUFKLENBQVV4QixLQUFLeUIsTUFBTCxDQUNmLDBGQURlLEVBRWZxQixvQkFGZSxDQUFWLENBQVA7QUFJRDs7QUFFREQsMkJBQXVCM0IsR0FBdkIsQ0FBMkJnQixPQUEzQixDQUFtQyxVQUFDZ0IsK0JBQUQsRUFBa0NDLCtCQUFsQyxFQUFzRTtBQUN2RyxVQUFJQSxrQ0FBa0MsQ0FBdEMsRUFBeUM7QUFDdkMsWUFBSyxPQUFRRCwrQkFBUixLQUE2QyxRQUE5QyxJQUNHLENBQUMsT0FBSzVDLFNBQUwsQ0FBZUMsV0FBZixFQUE0QjJDLCtCQUE1QixDQURSLEVBQ3NFO0FBQ3BFLGdCQUFPLElBQUkxQixLQUFKLENBQVV4QixLQUFLeUIsTUFBTCxDQUFZLGlFQUFaLEVBQStFcUIsb0JBQS9FLENBQVYsQ0FBUDtBQUNEO0FBQ0QsWUFBSXZDLFlBQVlhLE1BQVosQ0FBbUI4QiwrQkFBbkIsS0FDQzNDLFlBQVlhLE1BQVosQ0FBbUI4QiwrQkFBbkIsRUFBb0RuQixPQUR6RCxFQUNrRTtBQUNoRSxnQkFBTyxJQUFJUCxLQUFKLENBQVV4QixLQUFLeUIsTUFBTCxDQUNmLDZGQURlLEVBRWZxQixvQkFGZSxDQUFWLENBQVA7QUFJRDtBQUNGO0FBQ0YsS0FkRDs7QUFnQkEsUUFBSUQsdUJBQXVCUCxnQkFBM0IsRUFBNkM7QUFDM0MsVUFBSSxDQUFDeEMsRUFBRXlDLGFBQUYsQ0FBZ0JNLHVCQUF1QlAsZ0JBQXZDLENBQUwsRUFBK0Q7QUFDN0QsY0FBTyxJQUFJZCxLQUFKLENBQVV4QixLQUFLeUIsTUFBTCxDQUNmLHVGQURlLEVBRWZxQixvQkFGZSxDQUFWLENBQVA7QUFJRDs7QUFFRGhELFFBQUVvQyxPQUFGLENBQVVXLHVCQUF1QlAsZ0JBQWpDLEVBQW1ELFVBQUNjLGlCQUFELEVBQW9CQyxvQkFBcEIsRUFBNkM7QUFDOUYsWUFBSSxDQUFDLENBQUMsS0FBRCxFQUFRLE1BQVIsRUFBZ0JoQyxRQUFoQixDQUF5QitCLGtCQUFrQlYsV0FBbEIsRUFBekIsQ0FBTCxFQUFnRTtBQUM5RCxnQkFBTyxJQUFJbEIsS0FBSixDQUFVeEIsS0FBS3lCLE1BQUwsQ0FBWSxpRkFBWixFQUErRnFCLG9CQUEvRixDQUFWLENBQVA7QUFDRDtBQUNELFlBQUlELHVCQUF1QjNCLEdBQXZCLENBQTJCeUIsT0FBM0IsQ0FBbUNVLG9CQUFuQyxJQUEyRCxDQUEvRCxFQUFrRTtBQUNoRSxnQkFBTyxJQUFJN0IsS0FBSixDQUFVeEIsS0FBS3lCLE1BQUwsQ0FDZixzRkFEZSxFQUVmcUIsb0JBRmUsQ0FBVixDQUFQO0FBSUQ7QUFDRixPQVZEO0FBV0Q7QUFDRixHQTlNYTs7QUFnTmRRLGlCQUFlL0MsV0FBZixFQUE0QmdELFFBQTVCLEVBQXNDO0FBQ3BDLFFBQUksT0FBT0EsUUFBUCxLQUFvQixRQUF4QixFQUFrQztBQUNoQyxZQUFPLElBQUkvQixLQUFKLENBQVUscUNBQVYsQ0FBUDtBQUNEOztBQUVELFFBQU1nQyxnQkFBZ0JELFNBQVNFLE9BQVQsQ0FBaUIsUUFBakIsRUFBMkIsRUFBM0IsRUFBK0JDLEtBQS9CLENBQXFDLE9BQXJDLENBQXRCO0FBQ0EsUUFBSUYsY0FBY3ZCLE1BQWQsR0FBdUIsQ0FBM0IsRUFBOEI7QUFDNUJ1QixvQkFBYyxDQUFkLElBQW1CQSxjQUFjLENBQWQsRUFBaUJkLFdBQWpCLEVBQW5CO0FBQ0EsVUFBSSxDQUFDLENBQUMsU0FBRCxFQUFZLE1BQVosRUFBb0IsUUFBcEIsRUFBOEIsTUFBOUIsRUFBc0NyQixRQUF0QyxDQUErQ21DLGNBQWMsQ0FBZCxDQUEvQyxDQUFMLEVBQXVFO0FBQ3JFLGNBQU8sSUFBSWhDLEtBQUosQ0FBVXhCLEtBQUt5QixNQUFMLENBQVksb0NBQVosRUFBa0Q4QixRQUFsRCxDQUFWLENBQVA7QUFDRDtBQUNELFVBQUksQ0FBQyxLQUFLakQsU0FBTCxDQUFlQyxXQUFmLEVBQTRCaUQsY0FBYyxDQUFkLENBQTVCLENBQUwsRUFBb0Q7QUFDbEQsY0FBTyxJQUFJaEMsS0FBSixDQUFVeEIsS0FBS3lCLE1BQUwsQ0FBWSx3RUFBWixFQUFzRitCLGNBQWMsQ0FBZCxDQUF0RixDQUFWLENBQVA7QUFDRDtBQUNELFVBQUlqRCxZQUFZYSxNQUFaLENBQW1Cb0MsY0FBYyxDQUFkLENBQW5CLEtBQXdDakQsWUFBWWEsTUFBWixDQUFtQm9DLGNBQWMsQ0FBZCxDQUFuQixFQUFxQ3pCLE9BQWpGLEVBQTBGO0FBQ3hGLGNBQU8sSUFBSVAsS0FBSixDQUFVLDBFQUFWLENBQVA7QUFDRDtBQUNGLEtBWEQsTUFXTztBQUNMLFVBQUksQ0FBQyxLQUFLbEIsU0FBTCxDQUFlQyxXQUFmLEVBQTRCaUQsY0FBYyxDQUFkLENBQTVCLENBQUwsRUFBb0Q7QUFDbEQsY0FBTyxJQUFJaEMsS0FBSixDQUFVeEIsS0FBS3lCLE1BQUwsQ0FBWSxtRUFBWixFQUFpRitCLGNBQWMsQ0FBZCxDQUFqRixDQUFWLENBQVA7QUFDRDtBQUNELFVBQUlqRCxZQUFZYSxNQUFaLENBQW1Cb0MsY0FBYyxDQUFkLENBQW5CLEtBQXdDakQsWUFBWWEsTUFBWixDQUFtQm9DLGNBQWMsQ0FBZCxDQUFuQixFQUFxQ3pCLE9BQWpGLEVBQTBGO0FBQ3hGLGNBQU8sSUFBSVAsS0FBSixDQUFVLDBFQUFWLENBQVA7QUFDRDtBQUNGO0FBQ0YsR0F6T2E7O0FBMk9kbUMsd0JBQXNCcEQsV0FBdEIsRUFBbUNxRCxXQUFuQyxFQUFnRDtBQUM5QyxRQUFJLENBQUM5RCxFQUFFeUMsYUFBRixDQUFnQnFCLFdBQWhCLENBQUwsRUFBbUM7QUFDakMsWUFBTyxJQUFJcEMsS0FBSixDQUFVLGdFQUFWLENBQVA7QUFDRDtBQUNELFFBQUssT0FBUW9DLFlBQVlDLEVBQXBCLEtBQTRCLFFBQTdCLElBQTBDLENBQUMsS0FBS3ZELFNBQUwsQ0FBZUMsV0FBZixFQUE0QnFELFlBQVlDLEVBQXhDLENBQS9DLEVBQTRGO0FBQzFGLFlBQU8sSUFBSXJDLEtBQUosQ0FBVSxpR0FBVixDQUFQO0FBQ0Q7QUFDRCxRQUFJakIsWUFBWWEsTUFBWixDQUFtQndDLFlBQVlDLEVBQS9CLEtBQXNDdEQsWUFBWWEsTUFBWixDQUFtQndDLFlBQVlDLEVBQS9CLEVBQW1DOUIsT0FBN0UsRUFBc0Y7QUFDcEYsWUFBTyxJQUFJUCxLQUFKLENBQVUsbUZBQVYsQ0FBUDtBQUNEO0FBQ0QsUUFBSSxPQUFRb0MsWUFBWUUsS0FBcEIsS0FBK0IsUUFBbkMsRUFBNkM7QUFDM0MsWUFBTyxJQUFJdEMsS0FBSixDQUFVLDhEQUFWLENBQVA7QUFDRDtBQUNELFFBQUksQ0FBQzFCLEVBQUV5QyxhQUFGLENBQWdCcUIsWUFBWWxELE9BQTVCLENBQUwsRUFBMkM7QUFDekMsWUFBTyxJQUFJYyxLQUFKLENBQVUsNkVBQ2YsaURBREssQ0FBUDtBQUVEO0FBQ0YsR0E1UGE7O0FBOFBkdUMsd0JBQXNCeEQsV0FBdEIsRUFBbUM7QUFBQTs7QUFDakMsUUFBSSxDQUFDQSxXQUFMLEVBQWtCO0FBQ2hCLFlBQU8sSUFBSWlCLEtBQUosQ0FBVSw0QkFBVixDQUFQO0FBQ0Q7O0FBRUQsUUFBSSxDQUFDMUIsRUFBRXlDLGFBQUYsQ0FBZ0JoQyxZQUFZYSxNQUE1QixDQUFELElBQXdDNEMsT0FBT0MsSUFBUCxDQUFZMUQsWUFBWWEsTUFBeEIsRUFBZ0NhLE1BQWhDLEtBQTJDLENBQXZGLEVBQTBGO0FBQ3hGLFlBQU8sSUFBSVQsS0FBSixDQUFVLHFEQUFWLENBQVA7QUFDRDs7QUFFRCxRQUFJLENBQUNqQixZQUFZVyxHQUFiLElBQW9CLENBQUNwQixFQUFFa0MsT0FBRixDQUFVekIsWUFBWVcsR0FBdEIsQ0FBekIsRUFBcUQ7QUFDbkQsWUFBTyxJQUFJTSxLQUFKLENBQVUscUZBQVYsQ0FBUDtBQUNEOztBQUVEMUIsTUFBRW9DLE9BQUYsQ0FBVTNCLFlBQVlhLE1BQXRCLEVBQThCLFVBQUNHLFdBQUQsRUFBY2YsU0FBZCxFQUE0QjtBQUN4RCxhQUFLYyxjQUFMLENBQW9CZixXQUFwQixFQUFpQ2dCLFdBQWpDLEVBQThDZixTQUE5QztBQUNELEtBRkQ7O0FBSUEsU0FBS3NCLG9CQUFMLENBQTBCdkIsV0FBMUI7O0FBRUEsUUFBSUEsWUFBWTJELGtCQUFoQixFQUFvQztBQUNsQyxVQUFJLENBQUNwRSxFQUFFeUMsYUFBRixDQUFnQmhDLFlBQVkyRCxrQkFBNUIsQ0FBTCxFQUFzRDtBQUNwRCxjQUFPLElBQUkxQyxLQUFKLENBQVUsb0VBQVYsQ0FBUDtBQUNEO0FBQ0QxQixRQUFFb0MsT0FBRixDQUFVM0IsWUFBWTJELGtCQUF0QixFQUEwQyxVQUFDckIsc0JBQUQsRUFBeUJDLG9CQUF6QixFQUFrRDtBQUMxRixlQUFLRiwwQkFBTCxDQUFnQ3JDLFdBQWhDLEVBQTZDc0Msc0JBQTdDLEVBQXFFQyxvQkFBckU7QUFDRCxPQUZEO0FBR0Q7O0FBRUQsUUFBSXZDLFlBQVk0RCxPQUFoQixFQUF5QjtBQUN2QixVQUFJLENBQUNyRSxFQUFFa0MsT0FBRixDQUFVekIsWUFBWTRELE9BQXRCLENBQUwsRUFBcUM7QUFDbkMsY0FBTyxJQUFJM0MsS0FBSixDQUFVLGdEQUFWLENBQVA7QUFDRDs7QUFFRGpCLGtCQUFZNEQsT0FBWixDQUFvQmpDLE9BQXBCLENBQTRCLFVBQUNxQixRQUFELEVBQWM7QUFDeEMsZUFBS0QsY0FBTCxDQUFvQi9DLFdBQXBCLEVBQWlDZ0QsUUFBakM7QUFDRCxPQUZEO0FBR0Q7O0FBRUQsUUFBSWhELFlBQVk2RCxZQUFaLElBQTRCN0QsWUFBWThELGNBQTVDLEVBQTREO0FBQzFELFlBQU8sSUFBSTdDLEtBQUosQ0FBVSxnR0FBVixDQUFQO0FBQ0Q7O0FBRUQsUUFBSWpCLFlBQVk2RCxZQUFoQixFQUE4QjtBQUM1QixXQUFLVCxxQkFBTCxDQUEyQnBELFdBQTNCLEVBQXdDQSxZQUFZNkQsWUFBcEQ7QUFDRDs7QUFFRCxRQUFJN0QsWUFBWThELGNBQWhCLEVBQWdDO0FBQzlCLFVBQUksQ0FBQ3ZFLEVBQUVrQyxPQUFGLENBQVV6QixZQUFZOEQsY0FBdEIsQ0FBTCxFQUE0QztBQUMxQyxjQUFPLElBQUk3QyxLQUFKLENBQVUsOEVBQVYsQ0FBUDtBQUNEO0FBQ0RqQixrQkFBWThELGNBQVosQ0FBMkJuQyxPQUEzQixDQUFtQyxVQUFDMEIsV0FBRCxFQUFpQjtBQUNsRCxlQUFLRCxxQkFBTCxDQUEyQnBELFdBQTNCLEVBQXdDcUQsV0FBeEM7QUFDRCxPQUZEO0FBR0Q7QUFDRixHQXBUYTs7QUFzVGRVLHlCQUF1QkMsSUFBdkIsRUFBNkJDLFNBQTdCLEVBQXdDO0FBQ3RDLFFBQUksQ0FBQzFFLEVBQUV5QyxhQUFGLENBQWdCZ0MsSUFBaEIsQ0FBTCxFQUE0QjtBQUMxQixZQUFPLElBQUkvQyxLQUFKLENBQVV4QixLQUFLeUIsTUFBTCxDQUFZLDBEQUFaLEVBQXdFK0MsU0FBeEUsQ0FBVixDQUFQO0FBQ0Q7QUFDRCxRQUFJLE9BQU9ELEtBQUtFLFNBQVosS0FBMEIsVUFBOUIsRUFBMEM7QUFDeEMsWUFBTyxJQUFJakQsS0FBSixDQUFVeEIsS0FBS3lCLE1BQUwsQ0FBWSxrREFBWixFQUFnRStDLFNBQWhFLENBQVYsQ0FBUDtBQUNEO0FBQ0QsUUFBSSxDQUFDRCxLQUFLRyxPQUFWLEVBQW1CO0FBQ2pCSCxXQUFLRyxPQUFMLEdBQWUsS0FBS0MsOEJBQXBCO0FBQ0Q7QUFDRCxRQUFJLE9BQU9KLEtBQUtHLE9BQVosS0FBd0IsUUFBNUIsRUFBc0M7QUFDcENILFdBQUtHLE9BQUwsR0FBZSxTQUFTRSxFQUFULENBQVlGLE9BQVosRUFBcUI7QUFDbEMsZUFBTzFFLEtBQUt5QixNQUFMLENBQVlpRCxPQUFaLENBQVA7QUFDRCxPQUZjLENBRWJHLElBRmEsQ0FFUixJQUZRLEVBRUZOLEtBQUtHLE9BRkgsQ0FBZjtBQUdEO0FBQ0QsUUFBSSxPQUFPSCxLQUFLRyxPQUFaLEtBQXdCLFVBQTVCLEVBQXdDO0FBQ3RDLFlBQU8sSUFBSWxELEtBQUosQ0FBVXhCLEtBQUt5QixNQUFMLENBQVksa0VBQVosRUFBZ0YrQyxTQUFoRixDQUFWLENBQVA7QUFDRDtBQUNELFdBQU9ELElBQVA7QUFDRCxHQXpVYTs7QUEyVWRJLGlDQUErQkcsS0FBL0IsRUFBc0NDLFFBQXRDLEVBQWdEckQsU0FBaEQsRUFBMkQ7QUFDekQsV0FBTzFCLEtBQUt5QixNQUFMLENBQVksOENBQVosRUFBNERxRCxLQUE1RCxFQUFtRUMsUUFBbkUsRUFBNkVyRCxTQUE3RSxDQUFQO0FBQ0QsR0E3VWE7O0FBK1Vkc0QseUJBQXVCQyxVQUF2QixFQUFtQ0gsS0FBbkMsRUFBMEM7QUFDeEMsUUFBSUEsU0FBUyxJQUFULElBQWtCaEYsRUFBRXlDLGFBQUYsQ0FBZ0J1QyxLQUFoQixLQUEwQkEsTUFBTUksWUFBdEQsRUFBcUU7QUFDbkUsYUFBTyxJQUFQO0FBQ0Q7O0FBRUQsU0FBSyxJQUFJQyxJQUFJLENBQWIsRUFBZ0JBLElBQUlGLFdBQVdoRCxNQUEvQixFQUF1Q2tELEdBQXZDLEVBQTRDO0FBQzFDLFVBQUksT0FBT0YsV0FBV0UsQ0FBWCxFQUFjVixTQUFyQixLQUFtQyxVQUF2QyxFQUFtRDtBQUNqRCxZQUFJLENBQUNRLFdBQVdFLENBQVgsRUFBY1YsU0FBZCxDQUF3QkssS0FBeEIsQ0FBTCxFQUFxQztBQUNuQyxpQkFBT0csV0FBV0UsQ0FBWCxFQUFjVCxPQUFyQjtBQUNEO0FBQ0Y7QUFDRjtBQUNELFdBQU8sSUFBUDtBQUNELEdBNVZhOztBQThWZFUsaUJBQWU3RSxXQUFmLEVBQTRCaUUsU0FBNUIsRUFBdUM7QUFBQTs7QUFDckMsUUFBTVMsYUFBYSxFQUFuQjtBQUNBLFFBQU12RCxZQUFZLEtBQUtDLGNBQUwsQ0FBb0JwQixXQUFwQixFQUFpQ2lFLFNBQWpDLENBQWxCO0FBQ0EsUUFBTWEscUJBQXFCcEYsVUFBVXFGLHNCQUFWLENBQWlDNUQsU0FBakMsQ0FBM0I7O0FBRUEsUUFBSTJELGtCQUFKLEVBQXdCO0FBQ3RCSixpQkFBV2xFLElBQVgsQ0FBZ0JzRSxrQkFBaEI7QUFDRDs7QUFFRCxRQUFNRSxRQUFRaEYsWUFBWWEsTUFBWixDQUFtQm9ELFNBQW5CLENBQWQ7QUFDQSxRQUFJLE9BQU9lLE1BQU1oQixJQUFiLEtBQXNCLFdBQTFCLEVBQXVDO0FBQ3JDLFVBQUksT0FBT2dCLE1BQU1oQixJQUFiLEtBQXNCLFVBQTFCLEVBQXNDO0FBQ3BDZ0IsY0FBTWhCLElBQU4sR0FBYTtBQUNYRSxxQkFBV2MsTUFBTWhCLElBRE47QUFFWEcsbUJBQVMsS0FBS0M7QUFGSCxTQUFiO0FBSUFNLG1CQUFXbEUsSUFBWCxDQUFnQndFLE1BQU1oQixJQUF0QjtBQUNELE9BTkQsTUFNTyxJQUFJaUIsTUFBTXhELE9BQU4sQ0FBY3VELE1BQU1oQixJQUFOLENBQVdVLFVBQXpCLENBQUosRUFBMEM7QUFDL0NNLGNBQU1oQixJQUFOLENBQVdVLFVBQVgsQ0FBc0IvQyxPQUF0QixDQUE4QixVQUFDdUQsU0FBRCxFQUFlO0FBQzNDUixxQkFBV2xFLElBQVgsQ0FBZ0IsT0FBS3VELHNCQUFMLENBQTRCbUIsU0FBNUIsRUFBdUNqQixTQUF2QyxDQUFoQjtBQUNELFNBRkQ7QUFHRCxPQUpNLE1BSUEsSUFBSWUsTUFBTWhCLElBQU4sQ0FBV0UsU0FBZixFQUEwQjtBQUMvQlEsbUJBQVdsRSxJQUFYLENBQWdCLEtBQUt1RCxzQkFBTCxDQUE0QmlCLE1BQU1oQixJQUFsQyxFQUF3Q0MsU0FBeEMsQ0FBaEI7QUFDRDtBQUNGOztBQUVELFdBQU9TLFVBQVA7QUFDRCxHQXpYYTs7QUEyWGR0RCxpQkFBZXBCLFdBQWYsRUFBNEJDLFNBQTVCLEVBQXVDO0FBQ3JDLFFBQU1lLGNBQWNoQixZQUFZYSxNQUFaLENBQW1CWixTQUFuQixDQUFwQjs7QUFFQSxRQUFJLE9BQU9lLFdBQVAsS0FBdUIsUUFBM0IsRUFBcUM7QUFDbkMsYUFBT0EsV0FBUDtBQUNEO0FBQ0QsUUFBSXpCLEVBQUV5QyxhQUFGLENBQWdCaEIsV0FBaEIsQ0FBSixFQUFrQztBQUNoQyxhQUFPQSxZQUFZbUUsSUFBbkI7QUFDRDtBQUNELFVBQU8sSUFBSWxFLEtBQUosQ0FBVyxrQkFBaUJoQixTQUFVLHdCQUF0QyxDQUFQO0FBQ0QsR0FyWWE7O0FBdVlkbUYsb0JBQWtCcEYsV0FBbEIsRUFBK0JDLFNBQS9CLEVBQTBDO0FBQ3hDLFFBQUlELFlBQVlhLE1BQVosQ0FBbUJaLFNBQW5CLEVBQThCK0QsSUFBOUIsSUFBc0NoRSxZQUFZYSxNQUFaLENBQW1CWixTQUFuQixFQUE4QitELElBQTlCLENBQW1DcUIsUUFBN0UsRUFBdUY7QUFDckYsYUFBTyxJQUFQO0FBQ0Q7QUFDRCxXQUFPLEtBQVA7QUFDRCxHQTVZYTs7QUE4WWRDLHVCQUFxQnRGLFdBQXJCLEVBQWtDQyxTQUFsQyxFQUE2QztBQUMzQyxRQUFJRCxZQUFZVyxHQUFaLENBQWdCRyxRQUFoQixDQUF5QmIsU0FBekIsQ0FBSixFQUF5QztBQUN2QyxhQUFPLElBQVA7QUFDRDtBQUNELFFBQUlELFlBQVlXLEdBQVosQ0FBZ0IsQ0FBaEIsYUFBOEJzRSxLQUE5QixJQUF1Q2pGLFlBQVlXLEdBQVosQ0FBZ0IsQ0FBaEIsRUFBbUJHLFFBQW5CLENBQTRCYixTQUE1QixDQUEzQyxFQUFtRjtBQUNqRixhQUFPLElBQVA7QUFDRDtBQUNELFdBQU8sS0FBUDtBQUNELEdBdFphOztBQXdaZHFCLCtCQUE2QnRCLFdBQTdCLEVBQTBDQyxTQUExQyxFQUFxRDtBQUNuRCxRQUFJVixFQUFFeUMsYUFBRixDQUFnQmhDLFlBQVlhLE1BQVosQ0FBbUJaLFNBQW5CLENBQWhCLEtBQWtERCxZQUFZYSxNQUFaLENBQW1CWixTQUFuQixFQUE4QnNGLE9BQXBGLEVBQTZGO0FBQzNGLFVBQUloRyxFQUFFeUMsYUFBRixDQUFnQmhDLFlBQVlhLE1BQVosQ0FBbUJaLFNBQW5CLEVBQThCc0YsT0FBOUMsS0FDRyxDQUFFdkYsWUFBWWEsTUFBWixDQUFtQlosU0FBbkIsRUFBOEJzRixPQUE5QixDQUFzQ1osWUFEL0MsRUFDOEQ7QUFDNUQsZUFBTyxDQUFDLEtBQUQsRUFBUSxNQUFSLEVBQWdCLEtBQWhCLEVBQXVCLFFBQXZCLEVBQWlDN0QsUUFBakMsQ0FBMENkLFlBQVlhLE1BQVosQ0FBbUJaLFNBQW5CLEVBQThCa0YsSUFBeEUsQ0FBUDtBQUNEO0FBQ0QsYUFBTyxJQUFQO0FBQ0Q7QUFDRCxXQUFPLElBQVA7QUFDRDs7QUFqYWEsQ0FBaEI7O0FBcWFBSyxPQUFPQyxPQUFQLEdBQWlCOUYsT0FBakIiLCJmaWxlIjoic2NoZW1hLmpzIiwic291cmNlc0NvbnRlbnQiOlsiY29uc3QgXyA9IHJlcXVpcmUoJ2xvZGFzaCcpO1xuY29uc3QgdXRpbCA9IHJlcXVpcmUoJ3V0aWwnKTtcblxuY29uc3QgZGF0YXR5cGVzID0gcmVxdWlyZSgnLi9kYXRhdHlwZXMnKTtcblxuY29uc3Qgc2NoZW1lciA9IHtcbiAgdmFsaWRhdGVfdGFibGVfbmFtZSh0YWJsZU5hbWUpIHtcbiAgICByZXR1cm4gKHR5cGVvZiB0YWJsZU5hbWUgPT09ICdzdHJpbmcnICYmIC9eW2EtekEtWl0rW2EtekEtWjAtOV9dKi8udGVzdCh0YWJsZU5hbWUpKTtcbiAgfSxcbiAgaGFzX2ZpZWxkKG1vZGVsU2NoZW1hLCBmaWVsZE5hbWUpIHtcbiAgICBjb25zdCBvcHRpb25GaWVsZE5hbWVzID0gW107XG4gICAgaWYgKG1vZGVsU2NoZW1hLm9wdGlvbnMpIHtcbiAgICAgIGlmIChtb2RlbFNjaGVtYS5vcHRpb25zLnRpbWVzdGFtcHMpIHtcbiAgICAgICAgY29uc3QgdGltZXN0YW1wT3B0aW9ucyA9IHtcbiAgICAgICAgICBjcmVhdGVkQXQ6IG1vZGVsU2NoZW1hLm9wdGlvbnMudGltZXN0YW1wcy5jcmVhdGVkQXQgfHwgJ2NyZWF0ZWRBdCcsXG4gICAgICAgICAgdXBkYXRlZEF0OiBtb2RlbFNjaGVtYS5vcHRpb25zLnRpbWVzdGFtcHMudXBkYXRlZEF0IHx8ICd1cGRhdGVkQXQnLFxuICAgICAgICB9O1xuICAgICAgICBvcHRpb25GaWVsZE5hbWVzLnB1c2godGltZXN0YW1wT3B0aW9ucy5jcmVhdGVkQXQpO1xuICAgICAgICBvcHRpb25GaWVsZE5hbWVzLnB1c2godGltZXN0YW1wT3B0aW9ucy51cGRhdGVkQXQpO1xuICAgICAgfVxuXG4gICAgICBpZiAobW9kZWxTY2hlbWEub3B0aW9ucy52ZXJzaW9ucykge1xuICAgICAgICBjb25zdCB2ZXJzaW9uT3B0aW9ucyA9IHtcbiAgICAgICAgICBrZXk6IG1vZGVsU2NoZW1hLm9wdGlvbnMudmVyc2lvbnMua2V5IHx8ICdfX3YnLFxuICAgICAgICB9O1xuICAgICAgICBvcHRpb25GaWVsZE5hbWVzLnB1c2godmVyc2lvbk9wdGlvbnMua2V5KTtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIF8uaGFzKG1vZGVsU2NoZW1hLmZpZWxkcywgZmllbGROYW1lKSB8fCBvcHRpb25GaWVsZE5hbWVzLmluY2x1ZGVzKGZpZWxkTmFtZSk7XG4gIH0sXG4gIHZhbGlkYXRlX2ZpZWxkKG1vZGVsU2NoZW1hLCBmaWVsZE9iamVjdCwgZmllbGROYW1lKSB7XG4gICAgaWYgKCFmaWVsZE9iamVjdCkge1xuICAgICAgdGhyb3cgKG5ldyBFcnJvcih1dGlsLmZvcm1hdCgnU2NoZW1hIGZpZWxkIFwiJXNcIiBpcyBub3QgcHJvcGVybHkgZGVmaW5lZCcsIGZpZWxkTmFtZSkpKTtcbiAgICB9XG4gICAgY29uc3QgZmllbGR0eXBlID0gdGhpcy5nZXRfZmllbGRfdHlwZShtb2RlbFNjaGVtYSwgZmllbGROYW1lKTtcbiAgICBpZiAoIV8uaGFzKGRhdGF0eXBlcywgZmllbGR0eXBlKSkge1xuICAgICAgdGhyb3cgKG5ldyBFcnJvcih1dGlsLmZvcm1hdCgnSW52YWxpZCBmaWVsZCB0eXBlIFwiJXNcIiBmb3IgZmllbGQ6ICVzJywgZmllbGR0eXBlLCBmaWVsZE5hbWUpKSk7XG4gICAgfVxuICAgIGlmIChbJ21hcCcsICdsaXN0JywgJ3NldCcsICdmcm96ZW4nXS5pbmNsdWRlcyhmaWVsZHR5cGUpKSB7XG4gICAgICBpZiAoIWZpZWxkT2JqZWN0LnR5cGVEZWYpIHtcbiAgICAgICAgdGhyb3cgKG5ldyBFcnJvcih1dGlsLmZvcm1hdCgnTWlzc2luZyB0eXBlRGVmIGZvciBmaWVsZCB0eXBlIFwiJXNcIiBvbiBmaWVsZDogJXMnLCBmaWVsZHR5cGUsIGZpZWxkTmFtZSkpKTtcbiAgICAgIH1cbiAgICAgIGlmICh0eXBlb2YgZmllbGRPYmplY3QudHlwZURlZiAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgdGhyb3cgKG5ldyBFcnJvcih1dGlsLmZvcm1hdCgnSW52YWxpZCB0eXBlRGVmIGZvciBmaWVsZCB0eXBlIFwiJXNcIiBvbiBmaWVsZDogJXMnLCBmaWVsZHR5cGUsIGZpZWxkTmFtZSkpKTtcbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKCEodGhpcy5pc19maWVsZF9kZWZhdWx0X3ZhbHVlX3ZhbGlkKG1vZGVsU2NoZW1hLCBmaWVsZE5hbWUpKSkge1xuICAgICAgdGhyb3cgKG5ldyBFcnJvcih1dGlsLmZvcm1hdCgnSW52YWxpZCBkZWZhdWx0IHZhbHVlIGZvciBmaWVsZDogJXMoJXMpJywgZmllbGROYW1lLCBmaWVsZHR5cGUpKSk7XG4gICAgfVxuICB9LFxuXG4gIHZhbGlkYXRlX3ByaW1hcnlfa2V5KG1vZGVsU2NoZW1hKSB7XG4gICAgaWYgKHR5cGVvZiAobW9kZWxTY2hlbWEua2V5WzBdKSA9PT0gJ3N0cmluZycpIHtcbiAgICAgIGlmICghdGhpcy5oYXNfZmllbGQobW9kZWxTY2hlbWEsIG1vZGVsU2NoZW1hLmtleVswXSkpIHtcbiAgICAgICAgdGhyb3cgKG5ldyBFcnJvcignUGFydGl0aW9uIEtleSBtdXN0IGFsc28gYmUgYSB2YWxpZCBmaWVsZCBuYW1lJykpO1xuICAgICAgfVxuICAgICAgaWYgKG1vZGVsU2NoZW1hLmZpZWxkc1ttb2RlbFNjaGVtYS5rZXlbMF1dICYmIG1vZGVsU2NoZW1hLmZpZWxkc1ttb2RlbFNjaGVtYS5rZXlbMF1dLnZpcnR1YWwpIHtcbiAgICAgICAgdGhyb3cgKG5ldyBFcnJvcihcIlBhcnRpdGlvbiBLZXkgbXVzdCBhbHNvIGJlIGEgZGIgZmllbGQgbmFtZSwgY2FuJ3QgYmUgYSB2aXJ0dWFsIGZpZWxkIG5hbWVcIikpO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAoXy5pc0FycmF5KG1vZGVsU2NoZW1hLmtleVswXSkpIHtcbiAgICAgIGlmIChtb2RlbFNjaGVtYS5rZXlbMF0ubGVuZ3RoID09PSAwKSB7XG4gICAgICAgIHRocm93IChuZXcgRXJyb3IoXCJQYXJ0aXRpb24gS2V5IGFycmF5IGNhbid0IGJlIGVtcHR5XCIpKTtcbiAgICAgIH1cbiAgICAgIG1vZGVsU2NoZW1hLmtleVswXS5mb3JFYWNoKChwYXJ0aXRpb25LZXlGaWVsZCkgPT4ge1xuICAgICAgICBpZiAoKHR5cGVvZiAocGFydGl0aW9uS2V5RmllbGQpICE9PSAnc3RyaW5nJykgfHwgIXRoaXMuaGFzX2ZpZWxkKG1vZGVsU2NoZW1hLCBwYXJ0aXRpb25LZXlGaWVsZCkpIHtcbiAgICAgICAgICB0aHJvdyAobmV3IEVycm9yKCdQYXJ0aXRpb24gS2V5IGFycmF5IG11c3QgY29udGFpbiBvbmx5IHZhbGlkIGZpZWxkIG5hbWVzJykpO1xuICAgICAgICB9XG4gICAgICAgIGlmIChtb2RlbFNjaGVtYS5maWVsZHNbcGFydGl0aW9uS2V5RmllbGRdICYmIG1vZGVsU2NoZW1hLmZpZWxkc1twYXJ0aXRpb25LZXlGaWVsZF0udmlydHVhbCkge1xuICAgICAgICAgIHRocm93IChuZXcgRXJyb3IoXCJQYXJ0aXRpb24gS2V5IGFycmF5IG11c3QgY29udGFpbiBvbmx5IGRiIGZpZWxkIG5hbWVzLCBjYW4ndCBjb250YWluIHZpcnR1YWwgZmllbGQgbmFtZXNcIikpO1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhyb3cgKG5ldyBFcnJvcignUGFydGl0aW9uIEtleSBtdXN0IGJlIGEgZmllbGQgbmFtZSBzdHJpbmcsIG9yIGFycmF5IG9mIGZpZWxkIG5hbWVzJykpO1xuICAgIH1cblxuICAgIG1vZGVsU2NoZW1hLmtleS5mb3JFYWNoKChwcmltYXJ5S2V5RmllbGQsIHByaW1hcnlLZXlJbmRleCkgPT4ge1xuICAgICAgaWYgKHByaW1hcnlLZXlJbmRleCA+IDApIHtcbiAgICAgICAgaWYgKCh0eXBlb2YgKHByaW1hcnlLZXlGaWVsZCkgIT09ICdzdHJpbmcnKSB8fCAhdGhpcy5oYXNfZmllbGQobW9kZWxTY2hlbWEsIHByaW1hcnlLZXlGaWVsZCkpIHtcbiAgICAgICAgICB0aHJvdyAobmV3IEVycm9yKCdDbHVzdGVyaW5nIEtleXMgbXVzdCBiZSB2YWxpZCBmaWVsZCBuYW1lcycpKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAobW9kZWxTY2hlbWEuZmllbGRzW3ByaW1hcnlLZXlGaWVsZF0gJiYgbW9kZWxTY2hlbWEuZmllbGRzW3ByaW1hcnlLZXlGaWVsZF0udmlydHVhbCkge1xuICAgICAgICAgIHRocm93IChuZXcgRXJyb3IoXCJDbHVzdGVyaW5nIEtleXMgbXVzdCBiZSBkYiBmaWVsZCBuYW1lcywgY2FuJ3QgYmUgdmlydHVhbCBmaWVsZCBuYW1lc1wiKSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9KTtcblxuICAgIGlmIChtb2RlbFNjaGVtYS5jbHVzdGVyaW5nX29yZGVyKSB7XG4gICAgICBpZiAoIV8uaXNQbGFpbk9iamVjdChtb2RlbFNjaGVtYS5jbHVzdGVyaW5nX29yZGVyKSkge1xuICAgICAgICB0aHJvdyAobmV3IEVycm9yKCdjbHVzdGVyaW5nX29yZGVyIG11c3QgYmUgYW4gb2JqZWN0IG9mIGNsdXN0ZXJpbmdfa2V5IGF0dHJpYnV0ZXMnKSk7XG4gICAgICB9XG5cbiAgICAgIF8uZm9yRWFjaChtb2RlbFNjaGVtYS5jbHVzdGVyaW5nX29yZGVyLCAoY2x1c3RlcmluZ09yZGVyLCBjbHVzdGVyaW5nRmllbGROYW1lKSA9PiB7XG4gICAgICAgIGlmICghWydhc2MnLCAnZGVzYyddLmluY2x1ZGVzKGNsdXN0ZXJpbmdPcmRlci50b0xvd2VyQ2FzZSgpKSkge1xuICAgICAgICAgIHRocm93IChuZXcgRXJyb3IoJ2NsdXN0ZXJpbmdfb3JkZXIgYXR0cmlidXRlIHZhbHVlcyBjYW4gb25seSBiZSBBU0Mgb3IgREVTQycpKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAobW9kZWxTY2hlbWEua2V5LmluZGV4T2YoY2x1c3RlcmluZ0ZpZWxkTmFtZSkgPCAxKSB7XG4gICAgICAgICAgdGhyb3cgKG5ldyBFcnJvcignY2x1c3RlcmluZ19vcmRlciBmaWVsZCBhdHRyaWJ1dGVzIG11c3QgYmUgY2x1c3RlcmluZyBrZXlzIG9ubHknKSk7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgIH1cbiAgfSxcblxuICB2YWxpZGF0ZV9tYXRlcmlhbGl6ZWRfdmlldyhtb2RlbFNjaGVtYSwgbWF0ZXJpYWxpemVkVmlld09iamVjdCwgbWF0ZXJpYWxpemVkVmlld05hbWUpIHtcbiAgICBpZiAoIV8uaXNQbGFpbk9iamVjdChtYXRlcmlhbGl6ZWRWaWV3T2JqZWN0KSkge1xuICAgICAgdGhyb3cgKG5ldyBFcnJvcih1dGlsLmZvcm1hdCgnYXR0cmlidXRlIFwiJXNcIiB1bmRlciBtYXRlcmlhbGl6ZWRfdmlld3MgbXVzdCBiZSBhbiBvYmplY3QnLCBtYXRlcmlhbGl6ZWRWaWV3TmFtZSkpKTtcbiAgICB9XG5cbiAgICBpZiAoIW1hdGVyaWFsaXplZFZpZXdPYmplY3Quc2VsZWN0IHx8ICFtYXRlcmlhbGl6ZWRWaWV3T2JqZWN0LmtleSkge1xuICAgICAgdGhyb3cgKG5ldyBFcnJvcih1dGlsLmZvcm1hdCgnbWF0ZXJpYWxpemVkX3ZpZXcgXCIlc1wiIG11c3QgaGF2ZSBcInNlbGVjdFwiIGFuZCBcImtleVwiIGF0dHJpYnV0ZXMnLCBtYXRlcmlhbGl6ZWRWaWV3TmFtZSkpKTtcbiAgICB9XG5cbiAgICBpZiAoIV8uaXNBcnJheShtYXRlcmlhbGl6ZWRWaWV3T2JqZWN0LnNlbGVjdCkgfHwgIV8uaXNBcnJheShtYXRlcmlhbGl6ZWRWaWV3T2JqZWN0LmtleSkpIHtcbiAgICAgIHRocm93IChuZXcgRXJyb3IodXRpbC5mb3JtYXQoJ1wic2VsZWN0XCIgYW5kIFwia2V5XCIgYXR0cmlidXRlcyBtdXN0IGJlIGFuIGFycmF5IHVuZGVyIGF0dHJpYnV0ZSAlcyBvZiBtYXRlcmlhbGl6ZWRfdmlld3MnLCBtYXRlcmlhbGl6ZWRWaWV3TmFtZSkpKTtcbiAgICB9XG5cbiAgICBtYXRlcmlhbGl6ZWRWaWV3T2JqZWN0LnNlbGVjdC5mb3JFYWNoKChtYXRlcmlhbGl6ZWRWaWV3U2VsZWN0RmllbGQpID0+IHtcbiAgICAgIGlmICgodHlwZW9mIChtYXRlcmlhbGl6ZWRWaWV3U2VsZWN0RmllbGQpICE9PSAnc3RyaW5nJylcbiAgICAgICAgICAgIHx8ICEodGhpcy5oYXNfZmllbGQobW9kZWxTY2hlbWEsIG1hdGVyaWFsaXplZFZpZXdTZWxlY3RGaWVsZClcbiAgICAgICAgICAgIHx8IG1hdGVyaWFsaXplZFZpZXdTZWxlY3RGaWVsZCA9PT0gJyonKSkge1xuICAgICAgICB0aHJvdyAobmV3IEVycm9yKHV0aWwuZm9ybWF0KFxuICAgICAgICAgICd0aGUgc2VsZWN0IGF0dHJpYnV0ZSB1bmRlciBtYXRlcmlhbGl6ZWRfdmlldyAlcyBtdXN0IGJlIGFuIGFycmF5IG9mIGZpZWxkIG5hbWUgc3RyaW5ncyBvciBbXCIqXCJdJyxcbiAgICAgICAgICBtYXRlcmlhbGl6ZWRWaWV3TmFtZSxcbiAgICAgICAgKSkpO1xuICAgICAgfVxuXG4gICAgICBpZiAobW9kZWxTY2hlbWEuZmllbGRzW21hdGVyaWFsaXplZFZpZXdTZWxlY3RGaWVsZF1cbiAgICAgICAgICAmJiBtb2RlbFNjaGVtYS5maWVsZHNbbWF0ZXJpYWxpemVkVmlld1NlbGVjdEZpZWxkXS52aXJ0dWFsKSB7XG4gICAgICAgIHRocm93IChuZXcgRXJyb3IodXRpbC5mb3JtYXQoXG4gICAgICAgICAgJ3RoZSBzZWxlY3QgYXR0cmlidXRlIHVuZGVyICVzIG9mIG1hdGVyaWFsaXplZF92aWV3cyBtdXN0IGJlIGFuIGFycmF5IG9mIGRiIGZpZWxkIG5hbWVzLCAnICtcbiAgICAgICAgICAnY2Fubm90IGNvbnRhaW4gYW55IHZpcnR1YWwgZmllbGQgbmFtZScsXG4gICAgICAgICAgbWF0ZXJpYWxpemVkVmlld05hbWUsXG4gICAgICAgICkpKTtcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIC8vIHZhbGlkYXRlIG1hdGVyaWFsaXplZF92aWV3IHByaW1hcnkga2V5XG4gICAgaWYgKHR5cGVvZiAobWF0ZXJpYWxpemVkVmlld09iamVjdC5rZXlbMF0pID09PSAnc3RyaW5nJykge1xuICAgICAgaWYgKCF0aGlzLmhhc19maWVsZChtb2RlbFNjaGVtYSwgbWF0ZXJpYWxpemVkVmlld09iamVjdC5rZXlbMF0pKSB7XG4gICAgICAgIHRocm93IChuZXcgRXJyb3IodXRpbC5mb3JtYXQoJ21hdGVyaWFsaXplZF92aWV3ICVzOiBwYXJ0aXRpb24ga2V5IHN0cmluZyBtdXN0IG1hdGNoIGEgdmFsaWQgZmllbGQgbmFtZScsIG1hdGVyaWFsaXplZFZpZXdOYW1lKSkpO1xuICAgICAgfVxuICAgICAgaWYgKG1vZGVsU2NoZW1hLmZpZWxkc1ttYXRlcmlhbGl6ZWRWaWV3T2JqZWN0LmtleVswXV1cbiAgICAgICAgJiYgbW9kZWxTY2hlbWEuZmllbGRzW21hdGVyaWFsaXplZFZpZXdPYmplY3Qua2V5WzBdXS52aXJ0dWFsKSB7XG4gICAgICAgIHRocm93IChuZXcgRXJyb3IodXRpbC5mb3JtYXQoXG4gICAgICAgICAgJ21hdGVyaWFsaXplZF92aWV3ICVzOiBwYXJ0aXRpb24ga2V5IG11c3QgbWF0Y2ggYSBkYiBmaWVsZCBuYW1lLCBjYW5ub3QgYmUgYSB2aXJ0dWFsIGZpZWxkIG5hbWUnLFxuICAgICAgICAgIG1hdGVyaWFsaXplZFZpZXdOYW1lLFxuICAgICAgICApKSk7XG4gICAgICB9XG4gICAgfSBlbHNlIGlmIChfLmlzQXJyYXkobWF0ZXJpYWxpemVkVmlld09iamVjdC5rZXlbMF0pKSB7XG4gICAgICBpZiAobWF0ZXJpYWxpemVkVmlld09iamVjdC5rZXlbMF0ubGVuZ3RoID09PSAwKSB7XG4gICAgICAgIHRocm93IChuZXcgRXJyb3IodXRpbC5mb3JtYXQoJ21hdGVyaWFsaXplZF92aWV3ICVzOiBwYXJ0aXRpb24ga2V5IGFycmF5IGNhbm5vdCBiZSBlbXB0eScsIG1hdGVyaWFsaXplZFZpZXdOYW1lKSkpO1xuICAgICAgfVxuICAgICAgbWF0ZXJpYWxpemVkVmlld09iamVjdC5rZXlbMF0uZm9yRWFjaCgobWF0ZXJpYWxpemVkVmlld1BhcnRpdGlvbktleUZpZWxkKSA9PiB7XG4gICAgICAgIGlmICgodHlwZW9mIChtYXRlcmlhbGl6ZWRWaWV3UGFydGl0aW9uS2V5RmllbGQpICE9PSAnc3RyaW5nJylcbiAgICAgICAgICAgIHx8ICF0aGlzLmhhc19maWVsZChtb2RlbFNjaGVtYSwgbWF0ZXJpYWxpemVkVmlld1BhcnRpdGlvbktleUZpZWxkKSkge1xuICAgICAgICAgIHRocm93IChuZXcgRXJyb3IodXRpbC5mb3JtYXQoXG4gICAgICAgICAgICAnbWF0ZXJpYWxpemVkX3ZpZXcgJXM6IHBhcnRpdGlvbiBrZXkgYXJyYXkgbXVzdCBjb250YWluIG9ubHkgdmFsaWQgZmllbGQgbmFtZXMnLFxuICAgICAgICAgICAgbWF0ZXJpYWxpemVkVmlld05hbWUsXG4gICAgICAgICAgKSkpO1xuICAgICAgICB9XG4gICAgICAgIGlmIChtb2RlbFNjaGVtYS5maWVsZHNbbWF0ZXJpYWxpemVkVmlld1BhcnRpdGlvbktleUZpZWxkXVxuICAgICAgICAgICYmIG1vZGVsU2NoZW1hLmZpZWxkc1ttYXRlcmlhbGl6ZWRWaWV3UGFydGl0aW9uS2V5RmllbGRdLnZpcnR1YWwpIHtcbiAgICAgICAgICB0aHJvdyAobmV3IEVycm9yKHV0aWwuZm9ybWF0KFxuICAgICAgICAgICAgJ21hdGVyaWFsaXplZF92aWV3ICVzOiBwYXJ0aXRpb24ga2V5IGFycmF5IG11c3QgY29udGFpbiBvbmx5IGRiIGZpZWxkIG5hbWVzLCAnICtcbiAgICAgICAgICAgICdjYW5ub3QgY29udGFpbiB2aXJ0dWFsIGZpZWxkIG5hbWVzJyxcbiAgICAgICAgICAgIG1hdGVyaWFsaXplZFZpZXdOYW1lLFxuICAgICAgICAgICkpKTtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRocm93IChuZXcgRXJyb3IodXRpbC5mb3JtYXQoXG4gICAgICAgICdtYXRlcmlhbGl6ZWRfdmlldyAlczogcGFydGl0aW9uIGtleSBtdXN0IGJlIGEgZmllbGQgbmFtZSBzdHJpbmcsIG9yIGFycmF5IG9mIGZpZWxkIG5hbWVzJyxcbiAgICAgICAgbWF0ZXJpYWxpemVkVmlld05hbWUsXG4gICAgICApKSk7XG4gICAgfVxuXG4gICAgbWF0ZXJpYWxpemVkVmlld09iamVjdC5rZXkuZm9yRWFjaCgobWF0ZXJpYWxpemVkVmlld1ByaW1hcnlLZXlGaWVsZCwgbWF0ZXJpYWxpemVkVmlld1ByaW1hcnlLZXlJbmRleCkgPT4ge1xuICAgICAgaWYgKG1hdGVyaWFsaXplZFZpZXdQcmltYXJ5S2V5SW5kZXggPiAwKSB7XG4gICAgICAgIGlmICgodHlwZW9mIChtYXRlcmlhbGl6ZWRWaWV3UHJpbWFyeUtleUZpZWxkKSAhPT0gJ3N0cmluZycpXG4gICAgICAgICAgICB8fCAhdGhpcy5oYXNfZmllbGQobW9kZWxTY2hlbWEsIG1hdGVyaWFsaXplZFZpZXdQcmltYXJ5S2V5RmllbGQpKSB7XG4gICAgICAgICAgdGhyb3cgKG5ldyBFcnJvcih1dGlsLmZvcm1hdCgnbWF0ZXJpYWxpemVkX3ZpZXcgJXM6IGNsdXN0ZXJpbmcga2V5cyBtdXN0IGJlIHZhbGlkIGZpZWxkIG5hbWVzJywgbWF0ZXJpYWxpemVkVmlld05hbWUpKSk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKG1vZGVsU2NoZW1hLmZpZWxkc1ttYXRlcmlhbGl6ZWRWaWV3UHJpbWFyeUtleUZpZWxkXVxuICAgICAgICAgICYmIG1vZGVsU2NoZW1hLmZpZWxkc1ttYXRlcmlhbGl6ZWRWaWV3UHJpbWFyeUtleUZpZWxkXS52aXJ0dWFsKSB7XG4gICAgICAgICAgdGhyb3cgKG5ldyBFcnJvcih1dGlsLmZvcm1hdChcbiAgICAgICAgICAgICdtYXRlcmlhbGl6ZWRfdmlldyAlczogY2x1c3RlcmluZyBrZXlzIG11c3QgYmUgZGIgZmllbGQgbmFtZXMsIGNhbm5vdCBjb250YWluIHZpcnR1YWwgZmllbGRzJyxcbiAgICAgICAgICAgIG1hdGVyaWFsaXplZFZpZXdOYW1lLFxuICAgICAgICAgICkpKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0pO1xuXG4gICAgaWYgKG1hdGVyaWFsaXplZFZpZXdPYmplY3QuY2x1c3RlcmluZ19vcmRlcikge1xuICAgICAgaWYgKCFfLmlzUGxhaW5PYmplY3QobWF0ZXJpYWxpemVkVmlld09iamVjdC5jbHVzdGVyaW5nX29yZGVyKSkge1xuICAgICAgICB0aHJvdyAobmV3IEVycm9yKHV0aWwuZm9ybWF0KFxuICAgICAgICAgICdtYXRlcmlhbGl6ZWRfdmlldyAlczogY2x1c3RlcmluZ19vcmRlciBtdXN0IGJlIGFuIG9iamVjdCBvZiBjbHVzdGVyaW5nX2tleSBhdHRyaWJ1dGVzJyxcbiAgICAgICAgICBtYXRlcmlhbGl6ZWRWaWV3TmFtZSxcbiAgICAgICAgKSkpO1xuICAgICAgfVxuXG4gICAgICBfLmZvckVhY2gobWF0ZXJpYWxpemVkVmlld09iamVjdC5jbHVzdGVyaW5nX29yZGVyLCAobXZDbHVzdGVyaW5nT3JkZXIsIG12bHVzdGVyaW5nRmllbGROYW1lKSA9PiB7XG4gICAgICAgIGlmICghWydhc2MnLCAnZGVzYyddLmluY2x1ZGVzKG12Q2x1c3RlcmluZ09yZGVyLnRvTG93ZXJDYXNlKCkpKSB7XG4gICAgICAgICAgdGhyb3cgKG5ldyBFcnJvcih1dGlsLmZvcm1hdCgnbWF0ZXJpYWxpemVkX3ZpZXcgJXM6IGNsdXN0ZXJpbmdfb3JkZXIgYXR0cmlidXRlIHZhbHVlcyBjYW4gb25seSBiZSBBU0Mgb3IgREVTQycsIG1hdGVyaWFsaXplZFZpZXdOYW1lKSkpO1xuICAgICAgICB9XG4gICAgICAgIGlmIChtYXRlcmlhbGl6ZWRWaWV3T2JqZWN0LmtleS5pbmRleE9mKG12bHVzdGVyaW5nRmllbGROYW1lKSA8IDEpIHtcbiAgICAgICAgICB0aHJvdyAobmV3IEVycm9yKHV0aWwuZm9ybWF0KFxuICAgICAgICAgICAgJ21hdGVyaWFsaXplZF92aWV3ICVzOiBjbHVzdGVyaW5nX29yZGVyIGZpZWxkIGF0dHJpYnV0ZXMgbXVzdCBiZSBjbHVzdGVyaW5nIGtleXMgb25seScsXG4gICAgICAgICAgICBtYXRlcmlhbGl6ZWRWaWV3TmFtZSxcbiAgICAgICAgICApKSk7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgIH1cbiAgfSxcblxuICB2YWxpZGF0ZV9pbmRleChtb2RlbFNjaGVtYSwgaW5kZXhEZWYpIHtcbiAgICBpZiAodHlwZW9mIGluZGV4RGVmICE9PSAnc3RyaW5nJykge1xuICAgICAgdGhyb3cgKG5ldyBFcnJvcignaW5kZXhlcyBtdXN0IGJlIGFuIGFycmF5IG9mIHN0cmluZ3MnKSk7XG4gICAgfVxuXG4gICAgY29uc3QgaW5kZXhOYW1lTGlzdCA9IGluZGV4RGVmLnJlcGxhY2UoL1tcIlxcc10vZywgJycpLnNwbGl0KC9bKCldL2cpO1xuICAgIGlmIChpbmRleE5hbWVMaXN0Lmxlbmd0aCA+IDEpIHtcbiAgICAgIGluZGV4TmFtZUxpc3RbMF0gPSBpbmRleE5hbWVMaXN0WzBdLnRvTG93ZXJDYXNlKCk7XG4gICAgICBpZiAoIVsnZW50cmllcycsICdrZXlzJywgJ3ZhbHVlcycsICdmdWxsJ10uaW5jbHVkZXMoaW5kZXhOYW1lTGlzdFswXSkpIHtcbiAgICAgICAgdGhyb3cgKG5ldyBFcnJvcih1dGlsLmZvcm1hdCgnaW5kZXggXCIlc1wiIGlzIG5vdCBkZWZpbmVkIHByb3Blcmx5JywgaW5kZXhEZWYpKSk7XG4gICAgICB9XG4gICAgICBpZiAoIXRoaXMuaGFzX2ZpZWxkKG1vZGVsU2NoZW1hLCBpbmRleE5hbWVMaXN0WzFdKSkge1xuICAgICAgICB0aHJvdyAobmV3IEVycm9yKHV0aWwuZm9ybWF0KCdcIiVzXCIgaXMgbm90IGEgdmFsaWQgZmllbGQgbmFtZSwgaW5kZXhlcyBtdXN0IGJlIGRlZmluZWQgb24gZmllbGQgbmFtZXMnLCBpbmRleE5hbWVMaXN0WzFdKSkpO1xuICAgICAgfVxuICAgICAgaWYgKG1vZGVsU2NoZW1hLmZpZWxkc1tpbmRleE5hbWVMaXN0WzFdXSAmJiBtb2RlbFNjaGVtYS5maWVsZHNbaW5kZXhOYW1lTGlzdFsxXV0udmlydHVhbCkge1xuICAgICAgICB0aHJvdyAobmV3IEVycm9yKFwiaW5kZXhlcyBtdXN0IGJlIGFuIGFycmF5IG9mIGRiIGZpZWxkIG5hbWVzLCBjYW4ndCBjb250YWluIHZpcnR1YWwgZmllbGRzXCIpKTtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgaWYgKCF0aGlzLmhhc19maWVsZChtb2RlbFNjaGVtYSwgaW5kZXhOYW1lTGlzdFswXSkpIHtcbiAgICAgICAgdGhyb3cgKG5ldyBFcnJvcih1dGlsLmZvcm1hdCgnXCIlc1wiIGlzIG5vdCBhIHZhbGlkIGZpZWxkLCBpbmRleGVzIG11c3QgYmUgZGVmaW5lZCBvbiBmaWVsZCBuYW1lcycsIGluZGV4TmFtZUxpc3RbMF0pKSk7XG4gICAgICB9XG4gICAgICBpZiAobW9kZWxTY2hlbWEuZmllbGRzW2luZGV4TmFtZUxpc3RbMF1dICYmIG1vZGVsU2NoZW1hLmZpZWxkc1tpbmRleE5hbWVMaXN0WzBdXS52aXJ0dWFsKSB7XG4gICAgICAgIHRocm93IChuZXcgRXJyb3IoXCJpbmRleGVzIG11c3QgYmUgYW4gYXJyYXkgb2YgZGIgZmllbGQgbmFtZXMsIGNhbid0IGNvbnRhaW4gdmlydHVhbCBmaWVsZHNcIikpO1xuICAgICAgfVxuICAgIH1cbiAgfSxcblxuICB2YWxpZGF0ZV9jdXN0b21faW5kZXgobW9kZWxTY2hlbWEsIGN1c3RvbUluZGV4KSB7XG4gICAgaWYgKCFfLmlzUGxhaW5PYmplY3QoY3VzdG9tSW5kZXgpKSB7XG4gICAgICB0aHJvdyAobmV3IEVycm9yKCdjdXN0b21faW5kZXggbXVzdCBiZSBhbiBvYmplY3Qgd2l0aCBwcm9wZXIgaW5kZXhpbmcgYXR0cmlidXRlcycpKTtcbiAgICB9XG4gICAgaWYgKCh0eXBlb2YgKGN1c3RvbUluZGV4Lm9uKSAhPT0gJ3N0cmluZycpIHx8ICF0aGlzLmhhc19maWVsZChtb2RlbFNjaGVtYSwgY3VzdG9tSW5kZXgub24pKSB7XG4gICAgICB0aHJvdyAobmV3IEVycm9yKFwiY3VzdG9tX2luZGV4IG11c3QgaGF2ZSBhbiAnb24nIGF0dHJpYnV0ZSB3aXRoIHN0cmluZyB2YWx1ZSBhbmQgdmFsdWUgbXVzdCBiZSBhIHZhbGlkIGZpZWxkIG5hbWVcIikpO1xuICAgIH1cbiAgICBpZiAobW9kZWxTY2hlbWEuZmllbGRzW2N1c3RvbUluZGV4Lm9uXSAmJiBtb2RlbFNjaGVtYS5maWVsZHNbY3VzdG9tSW5kZXgub25dLnZpcnR1YWwpIHtcbiAgICAgIHRocm93IChuZXcgRXJyb3IoXCJjdXN0b21faW5kZXggJ29uJyBhdHRyaWJ1dGUgbXVzdCBiZSBhIGRiIGZpZWxkIG5hbWUsIGNhbid0IGNvbnRhaW4gdmlydHVhbCBmaWVsZHNcIikpO1xuICAgIH1cbiAgICBpZiAodHlwZW9mIChjdXN0b21JbmRleC51c2luZykgIT09ICdzdHJpbmcnKSB7XG4gICAgICB0aHJvdyAobmV3IEVycm9yKFwiY3VzdG9tX2luZGV4IG11c3QgaGF2ZSBhICd1c2luZycgYXR0cmlidXRlIHdpdGggc3RyaW5nIHZhbHVlXCIpKTtcbiAgICB9XG4gICAgaWYgKCFfLmlzUGxhaW5PYmplY3QoY3VzdG9tSW5kZXgub3B0aW9ucykpIHtcbiAgICAgIHRocm93IChuZXcgRXJyb3IoJ2N1c3RvbV9pbmRleCBtdXN0IGhhdmUgYW4gXCJvcHRpb25zXCIgYXR0cmlidXRlIGFuZCBpdCBtdXN0IGJlIGFuIG9iamVjdCwgJyArXG4gICAgICAgICdwYXNzIGJsYW5rIHt9IG9iamVjdCBpZiBubyBvcHRpb25zIGFyZSByZXF1aXJlZCcpKTtcbiAgICB9XG4gIH0sXG5cbiAgdmFsaWRhdGVfbW9kZWxfc2NoZW1hKG1vZGVsU2NoZW1hKSB7XG4gICAgaWYgKCFtb2RlbFNjaGVtYSkge1xuICAgICAgdGhyb3cgKG5ldyBFcnJvcignQSBzY2hlbWEgbXVzdCBiZSBzcGVjaWZpZWQnKSk7XG4gICAgfVxuXG4gICAgaWYgKCFfLmlzUGxhaW5PYmplY3QobW9kZWxTY2hlbWEuZmllbGRzKSB8fCBPYmplY3Qua2V5cyhtb2RlbFNjaGVtYS5maWVsZHMpLmxlbmd0aCA9PT0gMCkge1xuICAgICAgdGhyb3cgKG5ldyBFcnJvcignU2NoZW1hIG11c3QgY29udGFpbiBhIG5vbi1lbXB0eSBcImZpZWxkc1wiIG1hcCBvYmplY3QnKSk7XG4gICAgfVxuXG4gICAgaWYgKCFtb2RlbFNjaGVtYS5rZXkgfHwgIV8uaXNBcnJheShtb2RlbFNjaGVtYS5rZXkpKSB7XG4gICAgICB0aHJvdyAobmV3IEVycm9yKCdTY2hlbWEgbXVzdCBjb250YWluIFwia2V5XCIgaW4gdGhlIGZvcm06IFsgW3BhcnRpdGlvbmtleTEsIC4uLl0sIGNsdXN0ZXJpbmdrZXkxLCAuLi5dJykpO1xuICAgIH1cblxuICAgIF8uZm9yRWFjaChtb2RlbFNjaGVtYS5maWVsZHMsIChmaWVsZE9iamVjdCwgZmllbGROYW1lKSA9PiB7XG4gICAgICB0aGlzLnZhbGlkYXRlX2ZpZWxkKG1vZGVsU2NoZW1hLCBmaWVsZE9iamVjdCwgZmllbGROYW1lKTtcbiAgICB9KTtcblxuICAgIHRoaXMudmFsaWRhdGVfcHJpbWFyeV9rZXkobW9kZWxTY2hlbWEpO1xuXG4gICAgaWYgKG1vZGVsU2NoZW1hLm1hdGVyaWFsaXplZF92aWV3cykge1xuICAgICAgaWYgKCFfLmlzUGxhaW5PYmplY3QobW9kZWxTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzKSkge1xuICAgICAgICB0aHJvdyAobmV3IEVycm9yKCdtYXRlcmlhbGl6ZWRfdmlld3MgbXVzdCBiZSBhbiBvYmplY3Qgd2l0aCB2aWV3IG5hbWVzIGFzIGF0dHJpYnV0ZXMnKSk7XG4gICAgICB9XG4gICAgICBfLmZvckVhY2gobW9kZWxTY2hlbWEubWF0ZXJpYWxpemVkX3ZpZXdzLCAobWF0ZXJpYWxpemVkVmlld09iamVjdCwgbWF0ZXJpYWxpemVkVmlld05hbWUpID0+IHtcbiAgICAgICAgdGhpcy52YWxpZGF0ZV9tYXRlcmlhbGl6ZWRfdmlldyhtb2RlbFNjaGVtYSwgbWF0ZXJpYWxpemVkVmlld09iamVjdCwgbWF0ZXJpYWxpemVkVmlld05hbWUpO1xuICAgICAgfSk7XG4gICAgfVxuXG4gICAgaWYgKG1vZGVsU2NoZW1hLmluZGV4ZXMpIHtcbiAgICAgIGlmICghXy5pc0FycmF5KG1vZGVsU2NoZW1hLmluZGV4ZXMpKSB7XG4gICAgICAgIHRocm93IChuZXcgRXJyb3IoJ2luZGV4ZXMgbXVzdCBiZSBhbiBhcnJheSBvZiBmaWVsZCBuYW1lIHN0cmluZ3MnKSk7XG4gICAgICB9XG5cbiAgICAgIG1vZGVsU2NoZW1hLmluZGV4ZXMuZm9yRWFjaCgoaW5kZXhEZWYpID0+IHtcbiAgICAgICAgdGhpcy52YWxpZGF0ZV9pbmRleChtb2RlbFNjaGVtYSwgaW5kZXhEZWYpO1xuICAgICAgfSk7XG4gICAgfVxuXG4gICAgaWYgKG1vZGVsU2NoZW1hLmN1c3RvbV9pbmRleCAmJiBtb2RlbFNjaGVtYS5jdXN0b21faW5kZXhlcykge1xuICAgICAgdGhyb3cgKG5ldyBFcnJvcignYm90aCBjdXN0b21faW5kZXggYW5kIGN1c3RvbV9pbmRleGVzIGFyZSBkZWZpbmVkIGluIHNjaGVtYSwgb25seSBvbmUgb2YgdGhlbSBzaG91bGQgYmUgZGVmaW5lZCcpKTtcbiAgICB9XG5cbiAgICBpZiAobW9kZWxTY2hlbWEuY3VzdG9tX2luZGV4KSB7XG4gICAgICB0aGlzLnZhbGlkYXRlX2N1c3RvbV9pbmRleChtb2RlbFNjaGVtYSwgbW9kZWxTY2hlbWEuY3VzdG9tX2luZGV4KTtcbiAgICB9XG5cbiAgICBpZiAobW9kZWxTY2hlbWEuY3VzdG9tX2luZGV4ZXMpIHtcbiAgICAgIGlmICghXy5pc0FycmF5KG1vZGVsU2NoZW1hLmN1c3RvbV9pbmRleGVzKSkge1xuICAgICAgICB0aHJvdyAobmV3IEVycm9yKCdjdXN0b21faW5kZXhlcyBtdXN0IGJlIGFuIGFycmF5IHdpdGggb2JqZWN0cyB3aXRoIHByb3BlciBpbmRleGluZyBhdHRyaWJ1dGVzJykpO1xuICAgICAgfVxuICAgICAgbW9kZWxTY2hlbWEuY3VzdG9tX2luZGV4ZXMuZm9yRWFjaCgoY3VzdG9tSW5kZXgpID0+IHtcbiAgICAgICAgdGhpcy52YWxpZGF0ZV9jdXN0b21faW5kZXgobW9kZWxTY2hlbWEsIGN1c3RvbUluZGV4KTtcbiAgICAgIH0pO1xuICAgIH1cbiAgfSxcblxuICBmb3JtYXRfdmFsaWRhdGlvbl9ydWxlKHJ1bGUsIGZpZWxkbmFtZSkge1xuICAgIGlmICghXy5pc1BsYWluT2JqZWN0KHJ1bGUpKSB7XG4gICAgICB0aHJvdyAobmV3IEVycm9yKHV0aWwuZm9ybWF0KCdWYWxpZGF0aW9uIHJ1bGUgZm9yIFwiJXNcIiBtdXN0IGJlIGEgZnVuY3Rpb24gb3IgYW4gb2JqZWN0JywgZmllbGRuYW1lKSkpO1xuICAgIH1cbiAgICBpZiAodHlwZW9mIHJ1bGUudmFsaWRhdG9yICE9PSAnZnVuY3Rpb24nKSB7XG4gICAgICB0aHJvdyAobmV3IEVycm9yKHV0aWwuZm9ybWF0KCdSdWxlIHZhbGlkYXRvciBmb3IgXCIlc1wiIG11c3QgYmUgYSB2YWxpZCBmdW5jdGlvbicsIGZpZWxkbmFtZSkpKTtcbiAgICB9XG4gICAgaWYgKCFydWxlLm1lc3NhZ2UpIHtcbiAgICAgIHJ1bGUubWVzc2FnZSA9IHRoaXMuZ2V0X2dlbmVyaWNfdmFsaWRhdGlvbl9tZXNzYWdlO1xuICAgIH1cbiAgICBpZiAodHlwZW9mIHJ1bGUubWVzc2FnZSA9PT0gJ3N0cmluZycpIHtcbiAgICAgIHJ1bGUubWVzc2FnZSA9IGZ1bmN0aW9uIGYxKG1lc3NhZ2UpIHtcbiAgICAgICAgcmV0dXJuIHV0aWwuZm9ybWF0KG1lc3NhZ2UpO1xuICAgICAgfS5iaW5kKG51bGwsIHJ1bGUubWVzc2FnZSk7XG4gICAgfVxuICAgIGlmICh0eXBlb2YgcnVsZS5tZXNzYWdlICE9PSAnZnVuY3Rpb24nKSB7XG4gICAgICB0aHJvdyAobmV3IEVycm9yKHV0aWwuZm9ybWF0KCdJbnZhbGlkIHZhbGlkYXRvciBtZXNzYWdlIGZvciBcIiVzXCIsIG11c3QgYmUgc3RyaW5nIG9yIGEgZnVuY3Rpb24nLCBmaWVsZG5hbWUpKSk7XG4gICAgfVxuICAgIHJldHVybiBydWxlO1xuICB9LFxuXG4gIGdldF9nZW5lcmljX3ZhbGlkYXRpb25fbWVzc2FnZSh2YWx1ZSwgcHJvcE5hbWUsIGZpZWxkdHlwZSkge1xuICAgIHJldHVybiB1dGlsLmZvcm1hdCgnSW52YWxpZCBWYWx1ZTogXCIlc1wiIGZvciBGaWVsZDogJXMgKFR5cGU6ICVzKScsIHZhbHVlLCBwcm9wTmFtZSwgZmllbGR0eXBlKTtcbiAgfSxcblxuICBnZXRfdmFsaWRhdGlvbl9tZXNzYWdlKHZhbGlkYXRvcnMsIHZhbHVlKSB7XG4gICAgaWYgKHZhbHVlID09IG51bGwgfHwgKF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkgJiYgdmFsdWUuJGRiX2Z1bmN0aW9uKSkge1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgZm9yIChsZXQgdiA9IDA7IHYgPCB2YWxpZGF0b3JzLmxlbmd0aDsgdisrKSB7XG4gICAgICBpZiAodHlwZW9mIHZhbGlkYXRvcnNbdl0udmFsaWRhdG9yID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgIGlmICghdmFsaWRhdG9yc1t2XS52YWxpZGF0b3IodmFsdWUpKSB7XG4gICAgICAgICAgcmV0dXJuIHZhbGlkYXRvcnNbdl0ubWVzc2FnZTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gdHJ1ZTtcbiAgfSxcblxuICBnZXRfdmFsaWRhdG9ycyhtb2RlbFNjaGVtYSwgZmllbGRuYW1lKSB7XG4gICAgY29uc3QgdmFsaWRhdG9ycyA9IFtdO1xuICAgIGNvbnN0IGZpZWxkdHlwZSA9IHRoaXMuZ2V0X2ZpZWxkX3R5cGUobW9kZWxTY2hlbWEsIGZpZWxkbmFtZSk7XG4gICAgY29uc3QgdHlwZUZpZWxkVmFsaWRhdG9yID0gZGF0YXR5cGVzLmdlbmVyaWNfdHlwZV92YWxpZGF0b3IoZmllbGR0eXBlKTtcblxuICAgIGlmICh0eXBlRmllbGRWYWxpZGF0b3IpIHtcbiAgICAgIHZhbGlkYXRvcnMucHVzaCh0eXBlRmllbGRWYWxpZGF0b3IpO1xuICAgIH1cblxuICAgIGNvbnN0IGZpZWxkID0gbW9kZWxTY2hlbWEuZmllbGRzW2ZpZWxkbmFtZV07XG4gICAgaWYgKHR5cGVvZiBmaWVsZC5ydWxlICE9PSAndW5kZWZpbmVkJykge1xuICAgICAgaWYgKHR5cGVvZiBmaWVsZC5ydWxlID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgIGZpZWxkLnJ1bGUgPSB7XG4gICAgICAgICAgdmFsaWRhdG9yOiBmaWVsZC5ydWxlLFxuICAgICAgICAgIG1lc3NhZ2U6IHRoaXMuZ2V0X2dlbmVyaWNfdmFsaWRhdGlvbl9tZXNzYWdlLFxuICAgICAgICB9O1xuICAgICAgICB2YWxpZGF0b3JzLnB1c2goZmllbGQucnVsZSk7XG4gICAgICB9IGVsc2UgaWYgKEFycmF5LmlzQXJyYXkoZmllbGQucnVsZS52YWxpZGF0b3JzKSkge1xuICAgICAgICBmaWVsZC5ydWxlLnZhbGlkYXRvcnMuZm9yRWFjaCgoZmllbGRydWxlKSA9PiB7XG4gICAgICAgICAgdmFsaWRhdG9ycy5wdXNoKHRoaXMuZm9ybWF0X3ZhbGlkYXRpb25fcnVsZShmaWVsZHJ1bGUsIGZpZWxkbmFtZSkpO1xuICAgICAgICB9KTtcbiAgICAgIH0gZWxzZSBpZiAoZmllbGQucnVsZS52YWxpZGF0b3IpIHtcbiAgICAgICAgdmFsaWRhdG9ycy5wdXNoKHRoaXMuZm9ybWF0X3ZhbGlkYXRpb25fcnVsZShmaWVsZC5ydWxlLCBmaWVsZG5hbWUpKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICByZXR1cm4gdmFsaWRhdG9ycztcbiAgfSxcblxuICBnZXRfZmllbGRfdHlwZShtb2RlbFNjaGVtYSwgZmllbGROYW1lKSB7XG4gICAgY29uc3QgZmllbGRPYmplY3QgPSBtb2RlbFNjaGVtYS5maWVsZHNbZmllbGROYW1lXTtcblxuICAgIGlmICh0eXBlb2YgZmllbGRPYmplY3QgPT09ICdzdHJpbmcnKSB7XG4gICAgICByZXR1cm4gZmllbGRPYmplY3Q7XG4gICAgfVxuICAgIGlmIChfLmlzUGxhaW5PYmplY3QoZmllbGRPYmplY3QpKSB7XG4gICAgICByZXR1cm4gZmllbGRPYmplY3QudHlwZTtcbiAgICB9XG4gICAgdGhyb3cgKG5ldyBFcnJvcihgVHlwZSBvZiBmaWVsZCBcIiR7ZmllbGROYW1lfVwiIG5vdCBkZWZpbmVkIHByb3Blcmx5YCkpO1xuICB9LFxuXG4gIGlzX3JlcXVpcmVkX2ZpZWxkKG1vZGVsU2NoZW1hLCBmaWVsZE5hbWUpIHtcbiAgICBpZiAobW9kZWxTY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0ucnVsZSAmJiBtb2RlbFNjaGVtYS5maWVsZHNbZmllbGROYW1lXS5ydWxlLnJlcXVpcmVkKSB7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9LFxuXG4gIGlzX3ByaW1hcnlfa2V5X2ZpZWxkKG1vZGVsU2NoZW1hLCBmaWVsZE5hbWUpIHtcbiAgICBpZiAobW9kZWxTY2hlbWEua2V5LmluY2x1ZGVzKGZpZWxkTmFtZSkpIHtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICBpZiAobW9kZWxTY2hlbWEua2V5WzBdIGluc3RhbmNlb2YgQXJyYXkgJiYgbW9kZWxTY2hlbWEua2V5WzBdLmluY2x1ZGVzKGZpZWxkTmFtZSkpIHtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICByZXR1cm4gZmFsc2U7XG4gIH0sXG5cbiAgaXNfZmllbGRfZGVmYXVsdF92YWx1ZV92YWxpZChtb2RlbFNjaGVtYSwgZmllbGROYW1lKSB7XG4gICAgaWYgKF8uaXNQbGFpbk9iamVjdChtb2RlbFNjaGVtYS5maWVsZHNbZmllbGROYW1lXSkgJiYgbW9kZWxTY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0uZGVmYXVsdCkge1xuICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChtb2RlbFNjaGVtYS5maWVsZHNbZmllbGROYW1lXS5kZWZhdWx0KVxuICAgICAgICAgICYmICEobW9kZWxTY2hlbWEuZmllbGRzW2ZpZWxkTmFtZV0uZGVmYXVsdC4kZGJfZnVuY3Rpb24pKSB7XG4gICAgICAgIHJldHVybiBbJ21hcCcsICdsaXN0JywgJ3NldCcsICdmcm96ZW4nXS5pbmNsdWRlcyhtb2RlbFNjaGVtYS5maWVsZHNbZmllbGROYW1lXS50eXBlKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICByZXR1cm4gdHJ1ZTtcbiAgfSxcblxufTtcblxubW9kdWxlLmV4cG9ydHMgPSBzY2hlbWVyO1xuIl19