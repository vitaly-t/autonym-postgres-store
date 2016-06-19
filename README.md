# autonym-postgres-store

This is a package for the Autonym API framework. It is a light wrapper around the [pg-promise](https://github.com/vitaly-t/pg-promise) library with some convenience methods for model operations in Autonym.

## Usage

Simply import this service into your app and use the public methods.

```js
import PostgresStoreFactory from 'autonym-postgres-store';
const PostgresStore = PostgresStoreFactory();

class Person extends Model {
	static _init () {
		this.store = new PostgresStore('people', {
			perPage: 10,
			sort: '+name'
		});
	}

	static _find (query) {
		return this.store.find(query);
	}

	static _findOne (personId) {
		return this.store.findOne(personId);
	}

	static _create (attributes) {
		return this.store.create(attributes);
	}

	static _findOneAndUpdate (personId, attributes) {
		return this.store.findOneAndUpdate(personId, attributes);
	}

	static _findOneAndDelete (personId) {
		return this.store.findOneAndDelete(personId);
	}

	static _serialize (attributes) {
		return this.store.serialize(attributes);
	}

	static _unserialize (attributes) {
		return this.store.unserialize(attributes);
	}
}

export default Person;
```

## `PostgresStoreFactory([connectionString])`
### Arguments
* [string `connectionString`] A connection string to use to connect to Postgres. **Default:** `process.env.POSTGRES_CONNECTION`

### Return Values
* Returns a new `PostgresStore` class. Will return an existing class if the factory is invoked a second time using the same connection string.

### Example
```js
import PostgresStoreFactory from 'autonym-postgres-store';
const PostgresStore = PostgresStoreFactory(); // uses `process.env.POSTGRES_CONNECTION`
const Store1 = PostgresStoreFactory('postgres://root@localhost:5432/db'); // uses the given connection string
const Store2 = PostgresStoreFactory('postgres://root@localhost:5432/db'); // will share the Postgres connection with `Store1` because the string is the same
```

## `new PostgresStore(table, [options])`
### Arguments
* string|[string, string] `table` The name of the table to perform operations against. If passed an array, considers the first element to be the schema name and the second, the table name.
* [object `options`] Optional configuration.
  * [integer `perPage`] The number of records to return per page for `find()` calls. **Default:** no pagination.
  * [string `sort`] The default sorting of the result set for `find()` calls. Must be `+` (for ascending) or `-` (for descending) followed by a property name. The property will be passed to `options.serializeField(attribute)` to get the column name for the query. **Default:** No sorting.
  * [object function(attributes) `serialize`] A function that accepts a hash of properties and should return a new hash where the keys and values are safe for insertion into the table. **Default:** this function invokes `options.serializeField(attribute)` on each attribute name and returns a new object with the serialized keys.
  * [string function(attribute) `serializeField`] A function that accepts a property name and returns the name that is safe for query operations (usually a corresponding column name). **Default:** `_.snakeCase(attribute)`
  * [object function(attributes) `unserialize`] A function that accepts a hash of column names and values and should return a new hash in the format the API should respond with. **Default:** this function invokes `options.unserializeColumn(column)` on each attribute and returns a new object with the unserialized keys.
  * [string function(attribute) `unserializeColumn`] A function that accepts a column name and returns the name of the field that the API should respond with. **Default:** `_.camelCase(column)`

### Example
```js
let store = new PostgresStore('people'); // uses the `people` table

store = new PostgresStore(['app', 'people']); // uses the `people` table in the `app` schema

store = new PostgresStore('people', {
  perPage: 10, // limit the number of records per page to 10
  sort: '+lastName', // sort the results by the `lastName` property ascending
  serializeField: field => {
    switch (field) {
      case 'firstName': return 'fname';
      case 'lastName': return 'lname';
      default: return field;
    }
  }, // convert `firstName` to `fname` and `lastName` to `lname` before performing database operations
  unserializeColumn: column => {
    switch (column) {
      case 'fname': return 'firstName';
      case 'lname': return 'lastName';
      default: return field;
    }
  } // convert `fname` to `firstName` and `lname` to `lastName` before sending response
});
```

## `PostgresStore#find([query], [filter])`
### Arguments
* [object `query`] A flat hash, usually a result of the simple query string parser.
** [string `page`] The page number of the result set to fetch. **Default:** `1`
** [string `sort`] Sorting of the result set. Uses the same format as `options.sort`.
** [string `search[field]`] Filters the result set to records whose `field` value is equal to the parameter. `field` is passed to `options.serializeField()`.
** [string `search[field]~`] Filters the result set to records whose `field` value contains the parameter (case insensitive). `field` is passed to `options.serializeField()`.
** [string `search[field]!`] Filters the result set to records whose `field` value is not equal to the parameter. `field` is passed to `options.serializeField()`.
** [string `search[field]!~`] Filters the result set to records whose `field` value does not contain the parameter (case insensitive). `field` is passed to `options.serializeField()`.
* [object `filter`] Only include results that match this filter. Similar to forcing `query['search[field]']`.
** [string `field`] Filters the result set to records whose `field` value is equal to the parameter. `field` is passed to `options.serializeField()`.

### Return Values
* A promise. It resolves with an array of records passed through `options.unserialize()`.

### Example
```js
store.find().then(results => console.log(results)); // fetch the first page of results with no querying or filtering

// /people?page=2&sort=-lastName&search[firstName]=Joe&search[lastName]!=Schmoe&search[phoneNumber]~555&search[address]!~New York
store.find(
  {
    page: 2, // fetch page 2 of the results
    sort: '-lastName', // sort by last name descending
    'search[firstName]': 'Joe', // filter to records whose `firstName` fields are `Joe`
    'search[lastName]!': 'Schmoe', // filter to records whose `lastName` fields are not `Schmoe`
    'search[phoneNumber]~': '555', // filter to records whose `phoneNumber` fields contain `555`
    'search[address]!~': 'New York' // filter to records whose `address` fields do not contain `New York`
  },
  {
    clientId: 42 // filter to records whose `clientId` fields are set to `42`
  }
).then(results => console.log(results));
```

## `PostgresStore#findOne(id, [filter])`
### Arguments
* string `id` The value of the `id` property for the resource.
* [object `filter`] Only include results that match this filter. Uses the same format as `find()`'s `filter` argument.

### Return Values
* A promise. It resolves with one record passed through `options.unserialize()`.

### Example
```js
store.findOne(6).then(result => console.log(result)); // fetch record with `id` `42`

store.findOne(6, {
  clientId: 42 // only return the record if it has field `clientId` set to `42`
}).then(result => console.log(result));
```

## `PostgresStore#create(attributes)`
### Arguments
* object `attributes` The attributes to set on the new resource. Will be passed through `options.serialize()`.

### Return Values
* A promise. It resolves with one record passed through `options.unserialize()`.

### Example
```js
store.create({firstName: 'Joe', lastName: 'Schmoe'}).then(result => console.log(result)); // creates new resource
```

## `PostgresStore#findOneAndUpdate(id, attributes, [filter])`
### Arguments
* string `id` The value of the `id` property for the resource.
* object `attributes` The attributes that should be updated. Will be passed through `options.serialize()`.
* [object `filter`] Only update results that match this filter. Uses the same format as `find()`'s `filter` argument.

### Return Values
* A promise. It resolves with one record passed through `options.unserialize()`.

### Example
```js
store.findOneAndUpdate(6, {firstName: 'John'}).then(result => console.log(result)); // updates resource

store.findOneAndUpdate(6, {firstName: 'John'}, {clientId: 42}).then(result => console.log(result)); // updates resource if `clientId` is `42`
```

## `PostgresStore#findOneAndDelete(id, [filter])`
### Arguments
* string `id` The value of the `id` property for the resource.
* [object `filter`] Only delete results that match this filter. Uses the same format as `find()`'s `filter` argument.

### Return Values
* A promise. It resolves with one record passed through `options.unserialize()`.

### Example
```js
store.findOneAndDelete(6).then(result => console.log(result)); // deletes resource

store.findOneAndDelete(6, {clientId: 42}).then(result => console.log(result)); // deletes resource if `clientId` is `42`
```

## `PostgresStore#transformError(err)`
### Arguments
* Error `err` An error that was the result of a query. Will attempt to determine if the error is due to a system/developer error or a client error. If the error is determined to be a client error, will return an instance of a subclass of `autonym-client-errors.ClientError`.

### Return Values
* If the error was because the operation was supposed to return one result and returned zero, will return an instance of `autonym-client-errors.NotFoundError`.
* If the error was because the operation attempted to update or delete a resource but a foreign resource was referencing it, will return an instance of `autonym-client-errors.BadRequestError`.
* If the error was because the operation attempted to set a value but the field has a foreign constraint and the value did not match an existing resource id, will return an instance of `autonym-client-errors.BadRequestError`.
** If the Postgres index is named in the format of `table_name__column_1_name__column_2_name__column_N_name__idx`, will return an instance of `autonym-client-errors.InvalidPayloadError` with the response in the same format as JSON schema error reporting. The `keyword` property will be set to `foreignKey`.
* If the error was because the operation attempted to set a value but the field has a unique constraint and the value already existed in the table, will return an instance of `autonym-client-errors.BadRequestError`.
** If the Postgres index is named in the format of `table_name__column_1_name__column_2_name__column_N_name__idx`, will return an instance of `autonym-client-errors.InvalidPayloadError` with the response in the same format as JSON schema error reporting. The `keyword` property will be set to `unique`.

## `PostgresStore#none(...arguments)`
An alias for [`pg-promise.Database#none()`](http://vitaly-t.github.io/pg-promise/Database.html#.none). Will catch common user errors and pass to `PostgresStore#transformError(err)`.

## `PostgresStore#one(...arguments)`
An alias for [`pg-promise.Database#one()`](http://vitaly-t.github.io/pg-promise/Database.html#.one). Will catch common user errors and pass to `PostgresStore#transformError(err)`.

## `PostgresStore#many(...arguments)`
An alias for [`pg-promise.Database#many()`](http://vitaly-t.github.io/pg-promise/Database.html#.many). Will catch common user errors and pass to `PostgresStore#transformError(err)`.

## `PostgresStore#oneOrNone(...arguments)`
An alias for [`pg-promise.Database#oneOrNone()`](http://vitaly-t.github.io/pg-promise/Database.html#.oneOrNone). Will catch common user errors and pass to `PostgresStore#transformError(err)`.

## `PostgresStore#any(...arguments)`
An alias for [`pg-promise.Database#any()`](http://vitaly-t.github.io/pg-promise/Database.html#.any). Will catch common user errors and pass to `PostgresStore#transformError(err)`.`

## `PostgresStore#stringify(value)`
### Arguments
* any `value` A value to serialize before placing in a query

### Return Values
* If `value` is an object or array, calls `JSON.stringify()` on it and returns the result; otherwise, returns `value`.

### Examples
```js
store.stringify(5); // returns `5`
store.stringify('hello'); // returns `hello`
store.stringify(['a', 'b', 'c']); // returns `["a","b","c"]`
store.stringify({a: 1, b: 2}); // returns `{"a":1,"b":2}`
```
