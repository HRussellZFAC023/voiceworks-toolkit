from peewee import Model, CharField, TextField, SqliteDatabase

db = SqliteDatabase('cache.db')  # Creates a SQLite database file named 'cache.db'

class WorkCache(Model):
    cacheKey = CharField(primary_key=True)
    cacheData = TextField()

    class Meta:
        database = db
