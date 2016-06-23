'use strict';

Object.defineProperty(exports, "__esModule", {
	value: true
});

var _slicedToArray = function () { function sliceIterator(arr, i) { var _arr = []; var _n = true; var _d = false; var _e = undefined; try { for (var _i = arr[Symbol.iterator](), _s; !(_n = (_s = _i.next()).done); _n = true) { _arr.push(_s.value); if (i && _arr.length === i) break; } } catch (err) { _d = true; _e = err; } finally { try { if (!_n && _i["return"]) _i["return"](); } finally { if (_d) throw _e; } } return _arr; } return function (arr, i) { if (Array.isArray(arr)) { return arr; } else if (Symbol.iterator in Object(arr)) { return sliceIterator(arr, i); } else { throw new TypeError("Invalid attempt to destructure non-iterable instance"); } }; }();

var _pgPromise = require('pg-promise');

var _pgPromise2 = _interopRequireDefault(_pgPromise);

var _pgMonitor = require('pg-monitor');

var _pgMonitor2 = _interopRequireDefault(_pgMonitor);

var _lodash = require('lodash');

var _lodash2 = _interopRequireDefault(_lodash);

var _autonymClientErrors = require('autonym-client-errors');

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

const PAGE_REGEXP = /^[1-9][0-9]*$/;
const SORT_REGEXP = /^([-+])([a-zA-Z0-9_]+)$/;
const OPERATOR_MAP = { '': '=', '=': '=', '!=': '!=', '~': 'ILIKE', '!~': 'NOT ILIKE' };

const PG_ERROR_CODES = {
	restricted: '23001',
	foreignKey: '23503',
	uniqueKey: '23505',
	undefinedFunction: '42883',
	noData: _pgPromise2.default.errors.queryResultErrorCode.noData
};
const UNIQUE_KEY_ERROR_REGEXP = /unique constraint "(.+?)__(.+?)__uk"/;
const FOREIGN_KEY_ERROR_REGEXP = /foreign key constraint "(.+?)__(.+?)__fk"/;

const DEFAULT_SERIALIZE = function (attributes) {
	return _lodash2.default.mapKeys(attributes, (value, field) => this.serializeField(field));
};
const DEFAULT_SERIALIZE_FIELD = function (field) {
	return _lodash2.default.snakeCase(field);
};
const DEFAULT_UNSERIALIZE = function (attributes) {
	return _lodash2.default.mapKeys(attributes, (value, field) => this.unserializeColumn(field));
};
const DEFAULT_UNSERIALIZE_COLUMN = function (column) {
	return _lodash2.default.camelCase(column);
};

const classes = {};

function PostgresStoreFactory(connectionString) {
	connectionString = connectionString || process.env.POSTGRES_CONNECTION;

	if (classes[connectionString]) {
		return classes[connectionString];
	}

	const options = {
		query: e => _pgMonitor2.default.query(e),
		error: (err, e) => _pgMonitor2.default.error(err, e)
	};
	const Postgres = (0, _pgPromise2.default)(options);
	_pgMonitor2.default.attach(options);

	const db = Postgres(connectionString);

	class PostgresStore {
		constructor(table) {
			let options = arguments.length <= 1 || arguments[1] === undefined ? {} : arguments[1];

			this.db = db;

			var _ref = Array.isArray(table) ? table : [table];

			var _ref2 = _slicedToArray(_ref, 2);

			let _table = _ref2[0];
			let _schema = _ref2[1];

			this.table = new Postgres.helpers.TableName(_table, _schema).toString();

			this.options = Object.assign({ searchable: [] }, options);

			this.serialize = this.options.serialize || DEFAULT_SERIALIZE.bind(this);
			this.serializeField = this.options.serializeField || DEFAULT_SERIALIZE_FIELD.bind(this);
			this.unserialize = this.options.unserialize || DEFAULT_UNSERIALIZE.bind(this);
			this.unserializeColumn = this.options.unserializeColumn || DEFAULT_UNSERIALIZE_COLUMN.bind(this);
		}

		none() {
			return this.db.none(...arguments).catch(err => this.transformError(err));
		}

		one() {
			return this.db.one(...arguments).catch(err => this.transformError(err));
		}

		many() {
			return this.db.many(...arguments).catch(err => this.transformError(err));
		}

		oneOrNone() {
			return this.db.oneOrNone(...arguments).catch(err => this.transformError(err));
		}

		any() {
			return this.db.any(...arguments).catch(err => this.transformError(err));
		}

		find() {
			let query = arguments.length <= 0 || arguments[0] === undefined ? {} : arguments[0];
			let filter = arguments.length <= 1 || arguments[1] === undefined ? [] : arguments[1];

			let clause = this._createWhereClause(this._parseFilterAndSearch(filter, query));

			let orderBy = '';
			if (query.sort || this.options.sort) {
				let sort = query.sort && SORT_REGEXP.test(query.sort) ? query.sort : this.options.sort;
				if (sort) {
					var _sort$match = sort.match(SORT_REGEXP);

					var _sort$match2 = _slicedToArray(_sort$match, 3);

					let order = _sort$match2[1];
					let field = _sort$match2[2];

					orderBy = _pgPromise2.default.as.format(' ORDER BY $1~ $2^', [this.serializeField(field), order === '+' ? 'ASC' : 'DESC']);
				}
			}

			let limitOffset = '';
			if (this.options.perPage) {
				let page = PAGE_REGEXP.test(query.page) ? parseInt(query.page, 10) : 1;
				let offset = (page - 1) * this.options.perPage;
				limitOffset = _pgPromise2.default.as.format(' LIMIT $1 OFFSET $2', [this.options.perPage, offset]);
			}

			return this.any('SELECT * FROM $1^$2^$3^$4^', [this.table, clause, orderBy, limitOffset]);
		}

		findOne(id) {
			let filter = arguments.length <= 1 || arguments[1] === undefined ? [] : arguments[1];

			filter.push({ field: 'id', value: id });
			let clause = this._createWhereClause(this._parseFilterAndSearch(filter));

			return this.one('SELECT * FROM $1^$2^', [this.table, clause]);
		}

		create(attributes) {
			let columns = _lodash2.default.keys(attributes).map(_pgPromise2.default.as.name).join();
			let values = _lodash2.default.values(attributes).map(value => this.stringify(value));

			return this.one('INSERT INTO $1^ ($2^) VALUES ($3:csv) RETURNING *', [this.table, columns, values]);
		}

		findOneAndUpdate(id, attributes) {
			let filter = arguments.length <= 2 || arguments[2] === undefined ? [] : arguments[2];

			if (_lodash2.default.isEmpty(attributes)) {
				return this.findOne(id, this._parseFilterAndSearch(filter));
			}

			attributes = _lodash2.default.mapValues(attributes, value => this.stringify(value));
			let sets = Postgres.helpers.sets(attributes);

			filter.push({ field: 'id', value: id });
			let clause = this._createWhereClause(this._parseFilterAndSearch(filter));

			return this.one('UPDATE $1^ SET $2^$3^ RETURNING *', [this.table, sets, clause]);
		}

		findOneAndDelete(id) {
			let filter = arguments.length <= 1 || arguments[1] === undefined ? [] : arguments[1];

			filter.push({ field: 'id', value: id });
			let clause = this._createWhereClause(this._parseFilterAndSearch(filter));

			return this.one('DELETE FROM $1^$2^ RETURNING $3~', [this.table, clause, 'id']);
		}

		_parseFilterAndSearch(filter) {
			let query = arguments.length <= 1 || arguments[1] === undefined ? {} : arguments[1];

			filter = filter.map(_ref3 => {
				let field = _ref3.field;
				let value = _ref3.value;
				var _ref3$operator = _ref3.operator;
				let operator = _ref3$operator === undefined ? '=' : _ref3$operator;

				return { column: this.serializeField(field), value, operator };
			});

			_lodash2.default.forOwn(query.search, (search, field) => {
				let column = this.serializeField(field);

				const addSearchCondition = search => {
					let values = search.value;

					if (!Array.isArray(values)) {
						values = [values];
					}
					let operator = OPERATOR_MAP[search.operator || ''];
					if (!operator) {
						return;
					}

					values.forEach(value => {
						if (operator === 'ILIKE' || operator === 'NOT ILIKE') {
							value = '%' + value + '%';
						}

						if (this.options.searchable.indexOf(field) > -1) {
							filter.push({ column, value, operator });
						}
					});
				};

				if (!_lodash2.default.isPlainObject(search)) {
					search = { value: search, operator: '=' };
					addSearchCondition(search);
				} else {
					_lodash2.default.forOwn(search, (value, operator) => addSearchCondition({ value, operator }));
				}
			});

			return filter;
		}

		_createWhereClause(conditions) {
			if (_lodash2.default.isEmpty(conditions)) {
				return '';
			}

			conditions = conditions.map(_ref4 => {
				let column = _ref4.column;
				let operator = _ref4.operator;
				let value = _ref4.value;

				return _pgPromise2.default.as.format('$1~ $2^ $3', [column, operator, value]);
			});

			return ' WHERE ' + conditions.join(' AND ');
		}

		stringify(value) {
			if (Array.isArray(value) || _lodash2.default.isPlainObject(value)) {
				return JSON.stringify(value);
			} else {
				return value;
			}
		}

		transformError(err) {
			switch (err.code) {
				case PG_ERROR_CODES.undefinedFunction:
					// Happens when trying to use LIKE search against a non-string field
					err = new _autonymClientErrors.BadRequestError('Cannot search with `~` or `!~` operators against non-string fields.');
					break;
				case PG_ERROR_CODES.noData:
					err = new _autonymClientErrors.NotFoundError('No resource found that meets the given criteria.');
					break;

				case PG_ERROR_CODES.restricted:
					err = new _autonymClientErrors.BadRequestError('The given resource cannot be modified because it has dependent resources.');
					break;

				case PG_ERROR_CODES.foreignKey:
					try {
						var _err$message$match = err.message.match(FOREIGN_KEY_ERROR_REGEXP);

						var _err$message$match2 = _slicedToArray(_err$message$match, 3);

						let columns = _err$message$match2[2];

						columns = columns.split('__');
						err = new _autonymClientErrors.InvalidPayloadError(columns.map(column => ({
							keyword: 'foreignKey',
							dataPath: '.' + this.unserializeColumn(column),
							message: 'should reference an existent foreign resource'
						})));
					} catch (ex) {
						err = new _autonymClientErrors.BadRequestError('The given resource references a nonexistent foreign resource.');
					}
					break;

				case PG_ERROR_CODES.uniqueKey:
					try {
						var _err$message$match3 = err.message.match(UNIQUE_KEY_ERROR_REGEXP);

						var _err$message$match4 = _slicedToArray(_err$message$match3, 3);

						let columns = _err$message$match4[2];

						columns = columns.split('__');
						err = new _autonymClientErrors.InvalidPayloadError(columns.map(column => ({
							keyword: 'unique',
							dataPath: '.' + this.unserializeColumn(column),
							message: 'should be unique'
						})));
					} catch (ex) {
						err = new _autonymClientErrors.BadRequestError('The given resource violates a unique constraint.');
					}
					break;
			}

			throw err;
		}
	}

	classes[connectionString] = PostgresStore;
	return PostgresStore;
}

exports.default = PostgresStoreFactory;