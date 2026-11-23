"""Indian Railways reference data: the station list and each station's RailRadar timetable (migration 0017).

`railway_stations` comes from app/data/railway_stations.json, which merges api-allwin/Indian_Railway_Stations
and DataMeet's railways dataset (ODbL: credit it before redistributing or selling it). `city` is approximate
and about half the stations have no state; `metro` groups a big city's stations that the data files under
their own localities (Ahmedabad: Sabarmati, Maninagar, ...).

`railway_boards` holds the trains that start at a station, as RailRadar's 24-hour timetable gave them
(app/providers/railradar.py), so the setup wizard does not ask RailRadar again for everyone who opens it.
"""

from datetime import datetime

from sqlalchemy import JSON, Index, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TZDateTime


class RailwayStation(Base):
    __tablename__ = "railway_stations"
    __table_args__ = (
        Index("ix_railway_stations_state_city", "state", "city"),
        Index("ix_railway_stations_metro", "metro"),
    )

    code: Mapped[str] = mapped_column(String(8), primary_key=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    city: Mapped[str] = mapped_column(String(100), nullable=False, default="")
    state: Mapped[str] = mapped_column(String(60), nullable=False, default="")
    metro: Mapped[str | None] = mapped_column(String(60))


class RailwayBoard(Base):
    """Trains starting at one station: [{train_no, name, type, destination_code, destination_name,
    departure, departure_day, run_days}], as of fetched_at."""

    __tablename__ = "railway_boards"

    station_code: Mapped[str] = mapped_column(String(8), primary_key=True)
    fetched_at: Mapped[datetime] = mapped_column(TZDateTime(), nullable=False)
    station_name: Mapped[str | None] = mapped_column(String(120))
    trains: Mapped[list] = mapped_column(JSON, nullable=False, default=list)


__all__ = ["RailwayBoard", "RailwayStation"]
