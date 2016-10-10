import pgp from 'pg-promise';
import pgMonitor from 'pg-monitor';
import _ from 'lodash';
import {NotFoundError, BadRequestError, InvalidPayloadError} from 'autonym-client-errors';

const PAGE_REGEXP = /^[1-9][0-9]*$/;
const SORT_REGEXP = /^([-+])([a-zA-Z0-9_]+)$/;
const OPERATOR_MAP = {'': '=', '=': '=', '!=': '!=', '~': 'ILIKE', '!~': 'NOT ILIKE'};

const PG_ERROR_CODES = {
	restricted: '23001',
	foreignKey: '23503',
	uniqueKey: '23505',
	undefinedFunction: '42883',
	noData: pgp.errors.queryResultErrorCode.noData
};
const UNIQUE_KEY_ERROR_REGEXP = /unique constraint "(.+?)__(.+?)__uk"/;
const FOREIGN_KEY_ERROR_REGEXP = /foreign key constraint "(.+?)__(.+?)__fk"/;

const DEFAULT_SERIALIZE = function (attributes) {
	return _.mapKeys(attributes, (value, field) => this.serializeField(field));
};
const DEFAULT_SERIALIZE_FIELD = function (field) {
	return _.snakeCase(field);
};
const DEFAULT_UNSERIALIZE = function (attributes) {
	return _.mapKeys(attributes, (value, field) => this.unserializeColumn(field));
};
const DEFAULT_UNSERIALIZE_COLUMN = function (column) {
	return _.camelCase(column);
};

const classes = {};

function PostgresStoreFactory (connectionString) {
	connectionString = connectionString || process.env.POSTGRES_CONNECTION;
	
	if (classes[connectionString]) {
		return classes[connectionString];
	}
	
	const options = {
		query: e => pgMonitor.query(e),
		error: (err, e) => pgMonitor.error(err, e)
	};
	const Postgres = pgp(options);
	pgMonitor.attach(options);

	const db = Postgres(connectionString);

	class PostgresStore {
		constructor (table, options = {}) {
			this.db = db;

			let [_table, _schema] = Array.isArray(table) ? table : [table];
			this.table = new Postgres.helpers.TableName(_table, _schema).toString();

			this.options = Object.assign({searchable: []}, options);

			this.serialize = this.options.serialize || DEFAULT_SERIALIZE.bind(this);
			this.serializeField = this.options.serializeField || DEFAULT_SERIALIZE_FIELD.bind(this);
			this.unserialize = this.options.unserialize || DEFAULT_UNSERIALIZE.bind(this);
			this.unserializeColumn = this.options.unserializeColumn || DEFAULT_UNSERIALIZE_COLUMN.bind(this);
		}

		none () {
			return this.db.none(...arguments).catch(err => this.transformError(err));
		}

		one () {
			return this.db.one(...arguments).catch(err => this.transformError(err));
		}

		many () {
			return this.db.many(...arguments).catch(err => this.transformError(err));
		}

		oneOrNone () {
			return this.db.oneOrNone(...arguments).catch(err => this.transformError(err));
		}

		any () {
			return this.db.any(...arguments).catch(err => this.transformError(err));
		}

		find (query = {}, filter = []) {
			let clause = this._createWhereClause(this._parseFilterAndSearch(filter, query));

			let orderBy = '';
			if (query.sort || this.options.sort) {
				let sort = query.sort && SORT_REGEXP.test(query.sort) ? query.sort : this.options.sort;
				if (sort) {
					let [, order, field] = sort.match(SORT_REGEXP);
					orderBy = pgp.as.format(
						' ORDER BY $1~ $2^',
						[this.serializeField(field), order === '+' ? 'ASC' : 'DESC']
					);
				}
			}

			let limitOffset = '';
			if (this.options.perPage) {
				let page = PAGE_REGEXP.test(query.page) ? parseInt(query.page, 10) : 1;
				let offset = (page - 1) * this.options.perPage;
				limitOffset = pgp.as.format(
					' LIMIT $1 OFFSET $2',
					[this.options.perPage, offset]
				);
			}

			return this.any(
				'SELECT * FROM $1^$2^$3^$4^',
				[this.table, clause, orderBy, limitOffset]
			);
		}

		findOne (id, filter = []) {
			filter.push({field: 'id', value: id});
			let clause = this._createWhereClause(this._parseFilterAndSearch(filter));

			return this.one(
				'SELECT * FROM $1^$2^',
				[this.table, clause]
			);
		}

		create (attributes) {
			let columns = _.keys(attributes).map(pgp.as.name).join();
			let values = _.values(attributes).map(value => this.stringify(value));

			return this.one(
				'INSERT INTO $1^ ($2^) VALUES ($3:csv) RETURNING *',
				[this.table, columns, values]
			);
		}

		findOneAndUpdate (id, attributes, filter = []) {
			if (_.isEmpty(attributes)) {
				return this.findOne(id, this._parseFilterAndSearch(filter));
			}

			attributes = _.mapValues(attributes, value => this.stringify(value));
			let sets = Postgres.helpers.sets(attributes);

			filter.push({field: 'id', value: id});
			let clause = this._createWhereClause(this._parseFilterAndSearch(filter));

			return this.one(
				'UPDATE $1^ SET $2^$3^ RETURNING *',
				[this.table, sets, clause]
			);
		}

		findOneAndDelete (id, filter = []) {
			filter.push({field: 'id', value: id});
			let clause = this._createWhereClause(this._parseFilterAndSearch(filter));

			return this.one(
				'DELETE FROM $1^$2^ RETURNING $3~',
				[this.table, clause, 'id']
			);
		}

		_parseFilterAndSearch (filter, query = {}) {
			filter = filter.map(({field, value, operator = '='}) => {
				return {column: this.serializeField(field), value, operator};
			});

			_.forOwn(query.search, (search, field) => {
				let column = this.serializeField(field);
				
				const addSearchCondition = search => {
					let {value: values} = search;
					if (!Array.isArray(values)) { values = [values]; }
					let operator = OPERATOR_MAP[search.operator || ''];
					if (!operator) { return; }

					values.forEach(value => {
						if (operator === 'ILIKE' || operator === 'NOT ILIKE') {
							value = '%' + value + '%';
						} else if ((operator === '=' || operator === '!=') && value === 'NULL') {
							operator = operator === '=' ? 'IS' : 'IS NOT';
							value = null;
						}

						if (this.options.searchable.indexOf(field) > -1) {
							filter.push({column, value, operator});
						}
					});
				};
				
				if (!_.isPlainObject(search)) {
					search = {value: search, operator: '='};
					addSearchCondition(search);
				} else {
					_.forOwn(search, (value, operator) => addSearchCondition({value, operator}));
				}
			});

			return filter;
		}

		_createWhereClause (conditions) {
			if (_.isEmpty(conditions)) {
				return '';
			}

			conditions = conditions.map(({column, operator, value}) => {
				return pgp.as.format(
					'$1~ $2^ $3',
					[column, operator, value]
				);
			});

			return ' WHERE ' + conditions.join(' AND ');
		}

		stringify (value) {
			if (Array.isArray(value) || _.isPlainObject(value)) {
				return JSON.stringify(value);
			} else {
				return value;
			}
		}

		transformError (err) {
			switch (err.code) {
				case PG_ERROR_CODES.undefinedFunction:
					// Happens when trying to use LIKE search against a non-string field
					err = new BadRequestError('Cannot search with `~` or `!~` operators against non-string fields.');
					break;
				case PG_ERROR_CODES.noData:
					err = new NotFoundError('No resource found that meets the given criteria.');
					break;

				case PG_ERROR_CODES.restricted:
					err = new BadRequestError('The given resource cannot be modified because it has dependent resources.');
					break;

				case PG_ERROR_CODES.foreignKey:
					try {
						let [, , columns] = err.message.match(FOREIGN_KEY_ERROR_REGEXP);
						columns = columns.split('__');
						err = new InvalidPayloadError(columns.map(column => ({
							keyword: 'foreignKey',
							dataPath: '.' + this.unserializeColumn(column),
							message: 'should reference an existent foreign resource'
						})));
					} catch (ex) {
						err = new BadRequestError('The given resource references a nonexistent foreign resource.');
					}
					break;

				case PG_ERROR_CODES.uniqueKey:
					try {
						let [, , columns] = err.message.match(UNIQUE_KEY_ERROR_REGEXP);
						columns = columns.split('__');
						err = new InvalidPayloadError(columns.map(column => ({
							keyword: 'unique',
							dataPath: '.' + this.unserializeColumn(column),
							message: 'should be unique'
						})));
					} catch (ex) {
						err = new BadRequestError('The given resource violates a unique constraint.');
					}
					break;
			}

			throw err;
		}
	}
	
	classes[connectionString] = PostgresStore;
	return PostgresStore;
}

export default PostgresStoreFactory;
