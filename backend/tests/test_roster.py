"""Tests for roster CSV parsing (name, student_id, jaccount)."""

from __future__ import annotations

import pytest

from aimdware_backend.roster import RosterRow, read_roster


def test_parses_name_studentid_jaccount(tmp_path) -> None:
    p = tmp_path / "roster.csv"
    p.write_text(
        "名字,学号,jaccount\n张三,5190100001,zhangsan\n李四,5190100002,lisi\n",
        encoding="utf-8",
    )
    assert read_roster(str(p)) == [
        RosterRow(name="张三", student_id="5190100001", jaccount="zhangsan"),
        RosterRow(name="李四", student_id="5190100002", jaccount="lisi"),
    ]


def test_skips_header_row_and_blank_lines(tmp_path) -> None:
    p = tmp_path / "r.csv"
    p.write_text("name,student_id,jaccount\n\nAlice,5190,alice\n\n", encoding="utf-8")
    rows = read_roster(str(p))
    assert [r.jaccount for r in rows] == ["alice"]


def test_empty_student_id_becomes_none(tmp_path) -> None:
    p = tmp_path / "r.csv"
    p.write_text("Bob,,bob\n", encoding="utf-8")
    rows = read_roster(str(p))
    assert rows[0].student_id is None
    assert rows[0].jaccount == "bob"


def test_missing_jaccount_raises(tmp_path) -> None:
    p = tmp_path / "r.csv"
    p.write_text("Carol,5191,\n", encoding="utf-8")
    with pytest.raises(ValueError):
        read_roster(str(p))


def test_tolerates_utf8_bom(tmp_path) -> None:
    p = tmp_path / "r.csv"
    p.write_text("﻿Dave,5192,dave\n", encoding="utf-8")
    rows = read_roster(str(p))
    assert rows[0].jaccount == "dave"
