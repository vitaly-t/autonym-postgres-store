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
const SORT_REGEXP = /^([-+])([a-z0-9_]+)$/;
const SEARCH_REGEXP = /^search\[([a-z0-9_]+)](!|~|!~)?$/;
const OPERATOR_MAP = { '': '=', '!': '!=', '~': 'LIKE', '!~': 'NOT LIKE' };

const PG_ERROR_CODES = {
	restricted: '23001',
	foreignKey: '23503',
	uniqueKey: '23505',
	noData: Postgres.errors.queryResultErrorCode.noData
};
const UNIQUE_KEY_ERROR_REGEXP = /unique constraint "(.+?)__(.+?)__idx"/;
const FOREIGN_KEY_ERROR_REGEXP = /foreign key constraint "(.+?)__(.+?)__idx"/;

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
			this.table = Array.isArray(this.table) ? `"${ table[0] }"."${ table[1] }"` : `"${ table }"`;
			this.options = options;

			this.serialize = this.options.serialize || DEFAULT_SERIALIZE.bind(this);
			this.serializeField = this.options.serializeField || DEFAULT_SERIALIZE_FIELD.bind(this);
			this.unserialize = this.options.unserialize || DEFAULT_UNSERIALIZE.bind(this);
			this.unserializeColumn = this.options.unserializeColumn || DEFAULT_UNSERIALIZE_COLUMN.bind(this);
		}

		none() {
			return this.db.none.apply(this.db, arguments).catch(err => this.transformError(err));
		}

		one() {
			return this.db.one.apply(this.db, arguments).catch(err => this.transformError(err));
		}

		many() {
			return this.db.many.apply(this.db, arguments).catch(err => this.transformError(err));
		}

		oneOrNone() {
			return this.db.oneOrNone.apply(this.db, arguments).catch(err => this.transformError(err));
		}

		any() {
			return this.db.any.apply(this.db, arguments).catch(err => this.transformError(err));
		}

		find() {
			let query = arguments.length <= 0 || arguments[0] === undefined ? {} : arguments[0];
			let filter = arguments.length <= 1 || arguments[1] === undefined ? {} : arguments[1];

			let sql = `SELECT * FROM ${ this.table }`;

			var _createWhereClause = this._createWhereClause(this._parseFilterAndSearch(filter, query), 0);

			let clause = _createWhereClause.clause;
			let params = _createWhereClause.params;

			sql += clause;

			if (query.sort || this.options.sort) {
				let sort = query.sort && SORT_REGEXP.test(query.sort) ? query.sort : this.options.sort;
				if (sort) {
					var _sort$match = sort.match(SORT_REGEXP);

					var _sort$match2 = _slicedToArray(_sort$match, 3);

					let order = _sort$match2[1];
					let field = _sort$match2[2];

					sql += ` ORDER BY "${ this.serializeField(field) }" ${ order === '+' ? 'ASC' : 'DESC' }`;
				}
			}

			if (this.options.perPage) {
				let page = PAGE_REGEXP.test(query.page) ? parseInt(query.page, 10) : 1;
				let offset = (page - 1) * this.options.perPage;
				sql += ` LIMIT ${ this.options.perPage } OFFSET ${ offset }`;
			}

			return this.any(sql, params);
		}

		findOne(id) {
			let filter = arguments.length <= 1 || arguments[1] === undefined ? {} : arguments[1];

			let sql = `SELECT * FROM ${ this.table }`;

			filter.id = id;

			var _createWhereClause2 = this._createWhereClause(this._parseFilterAndSearch(filter));

			let clause = _createWhereClause2.clause;
			let params = _createWhereClause2.params;

			sql += clause;

			return this.one(`${ sql } LIMIT 1`, params);
		}

		create(attributes) {
			let sql = `INSERT INTO ${ this.table } `;

			let columns = _lodash2.default.keys(attributes);
			let params = _lodash2.default.values(attributes).map(value => this.stringify(value));
			let placeholders = _lodash2.default.range(1, columns.length + 1).map(i => `$${ i }`);

			sql += '("' + columns.join('", "') + '") VALUES (' + placeholders.join(', ') + ')';

			return this.one(`${ sql } RETURNING *`, params);
		}

		findOneAndUpdate(id, attributes) {
			let filter = arguments.length <= 2 || arguments[2] === undefined ? {} : arguments[2];

			if (_lodash2.default.isEmpty(attributes)) {
				return this.findOne(id, this._parseFilterAndSearch(filter));
			}

			let sql = `UPDATE ${ this.table } u SET `;

			let params = [];
			sql += (0, _lodash2.default)(attributes).map((value, column) => {
				params.push(value);
				return `"${ column }" = $${ params.length }`;
			}).value().join(', ');
			params = params.map(value => this.stringify(value));

			filter.id = id;

			var _createWhereClause3 = this._createWhereClause(this._parseFilterAndSearch(filter), params.length);

			let clause = _createWhereClause3.clause;
			let whereParams = _createWhereClause3.params;

			sql += ` FROM (SELECT * FROM ${ this.table }${ clause } LIMIT 1 FOR UPDATE) s WHERE s."id" = u."id" RETURNING u.*`;
			params = params.concat(whereParams);

			return this.one(sql, params);
		}

		findOneAndDelete(id) {
			let filter = arguments.length <= 1 || arguments[1] === undefined ? {} : arguments[1];

			let sql = `DELETE FROM ${ this.table }`;

			filter.id = id;

			var _createWhereClause4 = this._createWhereClause(this._parseFilterAndSearch(filter));

			let clause = _createWhereClause4.clause;
			let params = _createWhereClause4.params;

			sql += ` WHERE ctid IN (SELECT ctid FROM ${ this.table }${ clause } LIMIT 1) RETURNING "id"`;

			return this.one(sql, params);
		}

		_parseFilterAndSearch(filter) {
			let query = arguments.length <= 1 || arguments[1] === undefined ? {} : arguments[1];

			filter = _lodash2.default.transform(filter, (result, value, field) => {
				result[this.serializeField(field)] = _lodash2.default.isObject(value) ? value : { value, operator: '=' };
			}, {});

			_lodash2.default.forOwn(query, (value, key) => {
				try {
					var _key$match = key.match(SEARCH_REGEXP);

					var _key$match2 = _slicedToArray(_key$match, 3);

					let field = _key$match2[1];
					let operator = _key$match2[2];

					operator = OPERATOR_MAP[operator || ''];
					if (operator === 'LIKE' || operator === 'NOT LIKE') {
						value = `%${ value }%`;
					}
					filter[this.serializeField(field)] = { value, operator };
				} catch (ex) {
					// Not a search query param
				}
			});

			return filter;
		}

		_createWhereClause(filter) {
			let i = arguments.length <= 1 || arguments[1] === undefined ? 0 : arguments[1];

			if (_lodash2.default.isEmpty(filter)) {
				return { clause: '', params: [] };
			}

			let params = _lodash2.default.map(filter, 'value');
			let clause = ' WHERE ' + (0, _lodash2.default)(filter).map((_ref, column) => {
				let operator = _ref.operator;

				++i;

				let placeholder = `$${ i }`;
				if (operator === 'LIKE' || operator === 'NOT LIKE') {
					column = `LOWER("${ column }")`;
					placeholder = `LOWER($${ i })`;
					params[i] = `%${ params[i] }%`;
				}

				return `${ column } ${ operator } ${ placeholder }`;
			}).value().join(' AND ');

			return { clause, params };
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