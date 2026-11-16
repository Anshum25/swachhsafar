import uuid
from datetime import datetime, timedelta

from app.models import User, UserStatus
from app.security.lease import (
    PERMITTED_OFFLINE_OPERATIONS,
    issue_offline_lease,
    sign_lease_data,
    verify_offline_lease,
)


def test_offline_lease_issuance_and_verification():
    user = User(
        id=uuid.uuid4(),
        emp_id="EMP-TEST-01",
        email="emp@test.org",
        role_id=4,
        division_id=uuid.uuid4(),
        status=UserStatus.ACTIVE,
    )
    device_id = "web-1234567890abcdef"
    session_id = uuid.uuid4()

    lease = issue_offline_lease(user, device_id, session_id, offline_hours=12)

    assert lease["emp_id"] == "EMP-TEST-01"
    assert lease["user_id"] == str(user.id)
    assert lease["device_id"] == device_id
    assert lease["session_id"] == str(session_id)
    assert lease["permitted_operations"] == PERMITTED_OFFLINE_OPERATIONS
    assert "signature" in lease
    assert len(lease["signature"]) == 64

    # Verify signature
    assert verify_offline_lease(lease) is True

    # Tampered emp_id must fail
    tampered = dict(lease, emp_id="EMP-HACKER")
    assert verify_offline_lease(tampered) is False

    # Tampered device_id must fail
    tampered_dev = dict(lease, device_id="web-other")
    assert verify_offline_lease(tampered_dev) is False

    # Expired lease must fail
    past = (datetime.utcnow() - timedelta(hours=1)).isoformat()
    expired = dict(lease, expires_at=past)
    expired["signature"] = sign_lease_data(expired)
    assert verify_offline_lease(expired) is False


def test_offline_lease_capped_at_24_hours():
    user = User(
        id=uuid.uuid4(),
        emp_id="EMP-TEST-02",
        email="emp2@test.org",
        role_id=4,
        division_id=uuid.uuid4(),
        status=UserStatus.ACTIVE,
    )
    # Requesting 72 hours must be capped at 24
    lease = issue_offline_lease(user, "dev-1", uuid.uuid4(), offline_hours=72)
    issued = datetime.fromisoformat(lease["issued_at"])
    expires = datetime.fromisoformat(lease["expires_at"])
    duration = (expires - issued).total_seconds() / 3600.0
    assert duration <= 24.0

