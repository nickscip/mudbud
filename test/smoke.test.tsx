// Proves the harness itself before any real test leans on it: the tsconfig `@/` alias, NativeWind
// className passthrough, the reanimated mock under the worklets Babel plugin, moti, and the
// node:sqlite-backed expo-sqlite double.
//
// Deleted once the real suites cover the same ground — it exists to make a broken jest.config.js
// fail in one obvious place rather than in forty.

import { render, screen } from "@testing-library/react-native";
import { Text, View } from "react-native";
import React from "react";

import { createId } from "@/lib/id";
import { PressableScale } from "@/components/PressableScale";
import { PieceCard } from "@/components/PieceCard";
import { openDatabaseSync, __raw, __reset } from "expo-sqlite";

describe("test harness", () => {
  it("resolves the @/ alias through tsconfig paths", () => {
    expect(createId()).toEqual(expect.any(String));
  });

  it("passes className through as an inert prop", () => {
    render(
      <View className="flex-1" testID="styled">
        <Text>hi</Text>
      </View>
    );
    expect(screen.getByTestId("styled")).toBeTruthy();
  });

  it("renders a reanimated component without a reentrant-plugin error", () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      render(
        <PressableScale accessibilityLabel="press me">
          <Text>tap</Text>
        </PressableScale>
      );
      expect(screen.getByLabelText("press me")).toBeTruthy();
      // "Reentrant plugin detected" surfaces as console noise, not a throw, so a rendered tree
      // is not on its own evidence that the preset's second transformIgnorePattern survived.
      expect(error).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });

  it("renders a moti component", () => {
    render(
      <PieceCard
        piece={{
          id: "p1",
          title: "Morning mug",
          clayBody: "Stoneware",
          coverUri: null,
          status: "in_progress",
          notes: null,
          createdAt: 0,
          updatedAt: 0,
        }}
        onPress={() => {}}
      />
    );
    expect(screen.getByText("Morning mug")).toBeTruthy();
  });

  it("runs real SQL through the expo-sqlite double", () => {
    __reset();
    const db = openDatabaseSync("smoke.db");
    db.execSync("create table t (id integer primary key, name text not null)");
    const insert = db.prepareSync("insert into t (name) values (?)");
    const written = insert.executeSync(["clay"]);
    expect(written.changes).toBe(1);
    expect(written.lastInsertRowId).toBe(1);

    const read = db.prepareSync("select id, name from t");
    expect(read.executeSync([]).getAllSync()).toEqual([{ id: 1, name: "clay" }]);
    expect(read.executeForRawResultSync([]).getAllSync()).toEqual([[1, "clay"]]);

    expect(() => db.execSync("insert into t (name) values (null)")).toThrow();
    expect(__raw("smoke.db").prepare("select count(*) as n from t").get()).toEqual({ n: 1 });
  });

  it("rolls a failed transaction back", () => {
    __reset();
    const db = openDatabaseSync("tx.db");
    db.execSync("create table t (id integer primary key)");
    expect(() =>
      db.withTransactionSync(() => {
        db.execSync("insert into t (id) values (1)");
        throw new Error("boom");
      })
    ).toThrow("boom");
    expect(db.getAllSync("select * from t")).toEqual([]);
  });
});
