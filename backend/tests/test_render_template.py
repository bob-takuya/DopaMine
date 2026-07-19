"""Unit tests for the FSRS importer's mustache-subset template renderer.

Locks in the codex-review fix: nested same-field conditionals must pair by
innermost-close, and malformed/unclosed sections must not backtrack or crash.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.srs.fsrs_sqlite import FsrsSqliteEngine

render = FsrsSqliteEngine._render_template


def test_basic_field_and_frontside():
    assert render("{{Front}}", {"Front": "hi"}) == "hi"
    assert render("{{FrontSide}}<hr>{{Back}}", {"FrontSide": "Q", "Back": "A"}) == "Q<hr>A"


def test_unknown_tag_stripped_without_braces():
    out = render("a{{tts en_US:Front}}b{{hint:Foo}}c", {"Front": "x"})
    assert out == "abc"
    assert "{{" not in out and "}}" not in out


def test_positive_and_inverted_sections():
    assert render("{{#Extra}}[{{Extra}}]{{/Extra}}", {"Extra": "e"}) == "[e]"
    assert render("{{#Extra}}[{{Extra}}]{{/Extra}}", {"Extra": ""}) == ""
    assert render("{{^Extra}}none{{/Extra}}", {"Extra": ""}) == "none"
    assert render("{{^Extra}}none{{/Extra}}", {"Extra": "e"}) == ""


def test_nested_same_field_conditionals_pair_innermost():
    # The old regex paired the outer opener with the INNER closer. With F truthy
    # both levels are active and the full body renders; the trailing 'c' proves
    # the outer section did not close early at the first {{/F}}.
    tmpl = "{{#F}}a{{#F}}b{{/F}}c{{/F}}"
    assert render(tmpl, {"F": "1"}) == "abc"
    assert render(tmpl, {"F": ""}) == ""


def test_nested_mixed_fields():
    tmpl = "{{#A}}A{{#B}}B{{/B}}{{/A}}"
    assert render(tmpl, {"A": "1", "B": "1"}) == "AB"
    assert render(tmpl, {"A": "1", "B": ""}) == "A"
    assert render(tmpl, {"A": "", "B": "1"}) == ""


def test_malformed_unclosed_section_does_not_crash():
    # No matching {{/X}} — must not hang or raise; active section content is kept.
    assert render("{{#X}}kept{{Y}}", {"X": "1", "Y": "!"}) == "kept!"
    # stray close with no open is ignored
    assert render("plain{{/Z}}tail", {}) == "plaintail"
