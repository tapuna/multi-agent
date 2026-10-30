from sqlalchemy.orm import sessionmaker
from .database_config import database_url, make_engine

DATABASE_URL = database_url()
engine = make_engine(DATABASE_URL)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


def get_db():
    with SessionLocal() as session:
        yield session
