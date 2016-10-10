# autonym-postgres-store

This is a package for the Autonym API framework. It is a light wrapper around the [pg-promise](https://github.com/vitaly-t/pg-promise) library with some convenience methods for model operations in Autonym.

## Installation

Install into your project's dependencies with:

```bash
npm install --save autonym-postgres-store
```

## Basic usage
### Creating a connection
Import the module into your model file. This package exports a factory function, which is passed a Postgres connection string. If not provided, it will attempt to use the string defined in the environment variable `POSTGRES_CONNECTION`.

```js
import PostgresStoreFactory from 'autonym-postgres-store';
const PostgresStore = PostgresStoreFactory(); // uses `process.env.POSTGRES_CONNECTION`
// or
const PostgresStore = PostgresStoreFactory('postgres://USERNAME:PASSWORD@HOST:PORT/DB'); // uses given string
```

If Postgres is used in other models in your application, the existing database connection will be reused as long as the connection string is identical between invocations of the PostgresStoreFactory.

### Instantiating the store
You can instantiate the PostgresStore inside your `_init` method. It is common practice to save the instance as a property `store` on your class.

The first argument is the name of the table. If your table is not in the *public* schema, you can pass an array in instead, where the first value is the schema name and the second is the table name.

```js
import {Model} from 'autonym';
import PostgresStoreFactory from 'autonym-postgres-store';
const PostgresStore = PostgresStoreFactory();

class Person extends Model {
	_init () {
		this.store = new PostgresStore('people'); // table
		// or
		this.store = new PostgresStore(['myapp', 'people']); // [schema, table]
	}
}

export default Person;
```

The second argument is a set of options expressed as an object literal. Here are the options:

* [string] `searchable`: An array of field names that the user is allowed to search and sort on. If not provided, the user can perform searches on any field. Use the names as they are represented in your schema, not column names. **Example:** `['firstName', 'lastName']`.
* string `sort`: Specifies the default sort order of the results. The first character should be a `+` for ascending or `-` for descending sort. The rest of the string should be a field name to sort by. Use the names as they are represented in your schema, not column names. **Example:** `+lastName`. (Compound sort is not available yet.) This is overridden by specifying a `sort` field in the query string. Can only sort on *searchable* columns.
* integer `perPage`: The maximum number of records returned per page. By default, the records are not paginated. To fetch the *nth* page of results, the user should specify a `page` field in the query string (e.g. `page=2`). **Example:** `10`.
* function `serializeField(field)`: A function that converts a field name from the request to a column name. By default, this converts a field to snake_case. **Example:** `field => _.lowerCase(field)`.
* function `unserializeColumn(column)`: A function that converts a column name into a field name for the response. By default, this converts a column to camelCase. **Example:** `field => _.upperCase(field)`.
* function `serialize(attributes)`: A function that takes an attributes object and returns the object that gets passed to the create and update methods. By default it maps the keys of the incoming object against `serializeField` and returns the result.
* function `unserialize(attributes)`: A function that atkes an attributes object from find, findOne, create, and findOneAndUpdate calls and returns the object that is formatted for the API user. By default it maps the keys of the incoming object against `unserializeColumn` and returns the result.

```js
import {Model} from 'autonym';
import PostgresStoreFactory from 'autonym-postgres-store';
const PostgresStore = PostgresStoreFactory();

class Person extends Model {
	_init () {
		this.store = new PostgresStore('people', {
			perPage: 10,
			sort: '+lastName',
			searchable: ['firstName', 'lastName']
		});
	}
}

export default Person;
```

### Using the default behavior
The store instance has methods that are fully compatible with `_implementDefaultStoreCrudMethods`, so the quickest way to get started is to simply add this to your `_init` method:

```js
import {Model} from 'autonym';
import PostgresStoreFactory from 'autonym-postgres-store';
const PostgresStore = PostgresStoreFactory();

class Person extends Model {
	_init () {
		this.store = new PostgresStore('people', {
			perPage: 10,
			sort: '+lastName',
			searchable: ['firstName', 'lastName']
		});
		
		super._implementDefaultStoreCrudMethods(this.store);
	}
}

export default Person;
```

This simply implements `_create`, `_find`, `_findOne`, `_findOneAndUpdate`, and `_findOneAndDelete` on the model class, which pass their arguments onto the appropriate store methods.

Of course, if your model does not match up with the store methods quite as perfectly, you can also manually invoke any of these methods in your model methods manually.

### Query strings on find calls
The PostgresStore is equipped with basic searching, sorting, and paginating.

#### Searching
Users can perform basic searching by appending field/value pairs to the `search` query string parameter. For example, to search for people whose first name is `John`, use the path `/people?search[firstName]=John`.

Users can also use the "is not" operator, e.g. `/people?search[firstName][!=]=John`.

There are also "contains operators": `~` (contains) and `!~` (does not contain). These operators surround the query with wildcards (`%`) and use the `ILIKE` operator. Example: `/people?search[firstName][~]=jo&search[lastName][!~]=do`.

There is no support for "or" queries. Multiple parameters in `search` are all joined by `AND`.

Field names are passed to `serializeField` to produce column names to search by.

#### Sorting
Users can sort by one field by specifying the `sort` query string parameter. The first character must be a `+` for ascending or `-` ascending, and the rest of the value is the field to sort by. The field is passed to `serializeField` to produce the column name. Example: `/people?sort=+lastName`.

#### Pagination
For resources with `perPage` set, users can request a page by its number in the query string, e.g. `?page=2`. If the page is out of bounds, an empty result set is returned.

### Filters
Filters are used to limit the result or result set based on criteria not included in the search query but instead are added programmatically, for instance by policies. For example, a request to get a list of all users might be inherently limited to only users that the current user has permission to view; or a request to update a user might be limited to only the current user.

The Postgres store accepts filters in the format of `{field: 'employerId', value: '42', operator: '='}`. `field` represents a field that can be serialized to a column name, `value` the value to compare against, and `operator` one of `=`, `!=`, `~`, or `!~`. Filters are and'ed together and added to all queries to restrict the rows that can be read from or written to in the request. If `operator` is omitted, it defaults to `=`.

Example:

```js
// policies/restrict-to-public-profiles.policy.js

function restrictToPublicProfiles (req) {
  req.filters.push({field: 'public', value: true});
}

export default restrictToPublicProfiles;
```

```json
// schemas/person.schema.json

{
  "id": "Person",
  "policies": {
    "create": "isAdmin",
    "find": {"or": ["isLoggedIn", "restrictToPublicProfiles"]},
    "findOne": {"or": ["isLoggedIn", "restrictToPublicProfiles"]},
    "findOneAndUpdate": {"or": ["isAdmin", {"and": ["isLoggedIn", "isSelf"]}]},
    "findOneAndDelete": {"or": ["isAdmin", {"and": ["isLoggedIn", "isSelf"]}]}
  }
}
```

### Error handling
The PostgresStore has an error handling mechanism that tries to cast Postgres errors into instances of ClientError, which results in more appropriate error messages instead of just 500 errors.

#### When no resource is found
For findOne, findOneAndUpdate, and findOneAndDelete calls, the error will be caught and transformed into a 404 not found error.

#### When a unique constraint is violated
For create and findOneAndUpdate calls, if the user attempts to provide a value that violates a unique constraint, the error will be caught and transformed into a 400 bad request error. **Note:** If this unique index is named in a very particular way, PostgresStore can parse it and return an error message in the same format as schema validation errors. Simply name your index like this example: `table_name__col_1_name__col_2_name__uk` (i.e. table name + two underscores + each column involved in the unique key separated by two underscores + two underscores + uk).

#### When a foreign constraint is violated
For create and findOneAndUpdate calls, if the user attempts to provide a value that is supposed to be a foreign key, but no foreign resource exists with that id, the error will be caught and transformed into a 400 bad request error. **Note:** If the foreign key index is named in a very particular way, PostgresStore can parse it and return an error message in the same format as schema validation errors. Simply name your index like this example: `table_name__col_1_name__col_2_name__fk` (i.e. table name + two underscores + each column involved in the foreign key separated by two underscores + two underscores + fk).

#### When the resource to be deleted has foreign references pointed to it
For findOneAndDelete calls, if the user attempts to delete a resource but Postgres would not delete it because foreign resources have references pointed to it, the error will be caught and transformed into a 400 bad request error with details.

#### When attempting to search against non-string fields
If the user attempts to write a search query using the `~` (contains) or `!~` (does not contain) operators, if the field being searched on is not a string-based field, the error will be caught and transformed to a 400 bad request error with details.

Other errors are passed as is and will generate a 500 error.

### Method reference
The PostgresStore has various methods for direct usage in the model.

#### `create(attributes)`
Returns a promise that resolves with the newly created record, given the serialized attributes.

#### `find(query, filter)`
Returns a promise that resolves with an array of records, given a query (typically `req.query`) and optionally a filter, which is an array of additional restrictions for the WHERE clause (typically `req.filter`, which is populated by policies).

#### `findOne(id, filter)`
Returns a promise that resolves with the record, given its id and optionally a filter.

#### `findOneAndUpdate(id, attributes, filter)`
Returns a promise that resolves with the updated record, given the id of the record to update, the serialized attributes, and optionally a filter.

#### `findOneAndDelete(id, filter)`
Returns a promise that resolves with the deleted record's id, given the id of the record to delete and optionally a filter.

#### `transformError(err)`
Returns a new error if a more appropriate error can be gleaned from the Postgres error. (See "Error handling".) Otherwise returns the given error.

#### `none`, `one`, `many`, `oneOrNone`, `any`
These are all just wrappers for the equivalent functions in [pg-promise](https://github.com/vitaly-t/pg-promise). They catch errors with `transformError` and will throw ClientErrors if possible.
