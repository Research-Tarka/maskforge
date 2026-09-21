from __future__ import annotations

from pathlib import Path

from maskforge_core.class_config import ClassDef, ClassPalette, PaletteStore, default_palette


class TestClassDef:
    def test_to_from_dict_round_trip(self):
        c = ClassDef.new("Ice", (140, 170, 255), 3)
        d = c.to_dict()
        back = ClassDef.from_dict(d)
        assert back.id == c.id
        assert back.name == "Ice"
        assert back.color == (140, 170, 255)
        assert back.value == 3
        assert back.active_by_default is True


class TestPaletteStore:
    def test_save_and_get(self, tmp_path: Path):
        store = PaletteStore(tmp_path)
        palette = default_palette()
        store.save(palette)

        loaded = store.get(palette.id)
        assert loaded is not None
        assert loaded.name == "Default"
        assert len(loaded.classes) == 16

    def test_list_all_uses_index(self, tmp_path: Path):
        store = PaletteStore(tmp_path)
        p1 = ClassPalette.new("A")
        p2 = ClassPalette.new("B")
        store.save(p1)
        store.save(p2)

        all_palettes = store.list_all()
        names = {p.name for p in all_palettes}
        assert names == {"A", "B"}

    def test_index_file_created(self, tmp_path: Path):
        store = PaletteStore(tmp_path)
        store.save(default_palette())
        assert store.index_path.exists()

    def test_delete(self, tmp_path: Path):
        store = PaletteStore(tmp_path)
        p = default_palette()
        store.save(p)
        assert store.delete(p.id) is True
        assert store.get(p.id) is None
        assert store.delete(p.id) is False

    def test_get_missing_returns_none(self, tmp_path: Path):
        store = PaletteStore(tmp_path)
        assert store.get("nonexistent") is None

    def test_persistence_across_store_instances(self, tmp_path: Path):
        store1 = PaletteStore(tmp_path)
        palette = default_palette()
        store1.save(palette)

        store2 = PaletteStore(tmp_path)
        loaded = store2.get(palette.id)
        assert loaded is not None
        assert loaded.name == palette.name

    def test_color_and_value_maps(self):
        palette = default_palette()
        colors = palette.color_map()
        values = palette.value_map()
        assert colors["forest"] == (34, 94, 42)
        assert values["forest"] == 0
