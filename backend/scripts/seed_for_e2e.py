"""One-shot seeder for the e2e smoke run.

Inserts a User + Course + Enrollment (role=student) + StudentToken, and
prints the plaintext token to stdout so the calling script can capture
and feed it to the router.

The plaintext can be passed in via $E2E_PLAINTEXT for determinism;
otherwise a fresh one is generated.

Usage:
    AIMDWARE_DATABASE_URL=sqlite:///./aimdware.db \
        uv run python scripts/seed_for_e2e.py
"""
from __future__ import annotations

import hashlib
import os
import secrets
import sys
from uuid import uuid4

from sqlmodel import Session, SQLModel, select

from aimdware_backend.db import get_engine
from aimdware_backend.models import (
    Course,
    Enrollment,
    Role,
    StudentToken,
    User,
)


def main() -> int:
    engine = get_engine()
    SQLModel.metadata.create_all(engine)

    plaintext = os.environ.get("E2E_PLAINTEXT")
    if not plaintext:
        plaintext = "st_" + secrets.token_urlsafe(32)

    jaccount = os.environ.get("E2E_JACCOUNT", "zhangsan")
    course_code = os.environ.get("E2E_COURSE", "ECE4721J")

    with Session(engine) as s:
        user = s.exec(select(User).where(User.jaccount == jaccount)).first()
        if user is None:
            user = User(
                id=uuid4(),
                display_name="E2E Student",
                email=f"{jaccount}@sjtu.edu.cn",
                jaccount=jaccount,
            )
            s.add(user)
            s.commit()
            s.refresh(user)

        course = s.exec(select(Course).where(Course.code == course_code)).first()
        if course is None:
            course = Course(
                id=uuid4(),
                code=course_code,
                title="Intro to Systems",
                semester="2026-spring",
            )
            s.add(course)
            s.commit()
            s.refresh(course)

        enrol = s.exec(
            select(Enrollment).where(
                Enrollment.user_id == user.id,
                Enrollment.course_id == course.id,
            )
        ).first()
        if enrol is None:
            s.add(
                Enrollment(
                    user_id=user.id, course_id=course.id, role=Role.student
                )
            )
            s.commit()

        digest = hashlib.sha256(plaintext.encode()).digest()
        existing = s.exec(
            select(StudentToken).where(StudentToken.token_hash == digest)
        ).first()
        if existing is None:
            s.add(
                StudentToken(
                    user_id=user.id, token_hash=digest, prefix=plaintext[:8]
                )
            )
            s.commit()

    print(plaintext, end="")
    return 0


if __name__ == "__main__":
    sys.exit(main())
