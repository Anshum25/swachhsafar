"""Reverse geocoding: an address for the photo stamp, never a reason a record cannot be saved."""

from app.api.v1 import geo
from app.providers.external import ProviderUnavailable, get_geocode_provider
from app.main import app

API = "/api/v1"


class FakeGeocoder:
    enabled = True

    def __init__(self, address="Platform 1, Bhopal Junction, Madhya Pradesh 462001, India"):
        self.address, self.calls, self.fails = address, [], False

    def reverse(self, lat, lon):
        self.calls.append((lat, lon))
        if self.fails:
            raise ProviderUnavailable("down")
        return self.address


def use(provider):
    app.dependency_overrides[get_geocode_provider] = lambda: provider
    geo._cache.clear()
    return provider


def test_address_is_returned_and_then_served_from_cache(client, world):
    fake = use(FakeGeocoder())
    r = client.get(f"{API}/geo/reverse", params={"lat": 23.2599, "lon": 77.4126}, headers=world.h("sup"))
    assert r.status_code == 200 and r.json() == {"address": fake.address, "source": "lookup"}
    # A second capture a few metres away is the same rounded point: one lookup, not two.
    again = client.get(f"{API}/geo/reverse", params={"lat": 23.25991, "lon": 77.41262}, headers=world.h("sup"))
    assert again.json()["source"] == "cache" and again.json()["address"] == fake.address
    assert len(fake.calls) == 1
    app.dependency_overrides.pop(get_geocode_provider)


def test_a_provider_that_is_down_or_off_costs_nothing(client, world):
    fake = use(FakeGeocoder())
    fake.fails = True
    r = client.get(f"{API}/geo/reverse", params={"lat": 19.0, "lon": 72.8}, headers=world.h("sup"))
    assert r.status_code == 200 and r.json() == {"address": None, "source": "unavailable"}

    class Off:
        enabled = False

        def reverse(self, lat, lon):
            raise AssertionError("must not be called")

    use(Off())
    r = client.get(f"{API}/geo/reverse", params={"lat": 19.0, "lon": 72.8}, headers=world.h("sup"))
    assert r.json() == {"address": None, "source": "disabled"}
    app.dependency_overrides.pop(get_geocode_provider)


def test_rejects_nonsense_coordinates_and_anonymous_callers(client, world):
    use(FakeGeocoder())
    assert client.get(f"{API}/geo/reverse", params={"lat": 99, "lon": 0}, headers=world.h("sup")).status_code == 422
    assert client.get(f"{API}/geo/reverse", params={"lat": 0, "lon": 999}, headers=world.h("sup")).status_code == 422
    assert client.get(f"{API}/geo/reverse", params={"lat": 19.0, "lon": 72.8}).status_code == 401
    app.dependency_overrides.pop(get_geocode_provider)
