// Who may see and do what, per role and team (server/access.ts): every page and server action asks there.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  type Ability,
  blockedAdmin,
  can,
  canSeeRequest,
  decisionProblem,
  invitationProblem,
  LIMITS,
  requestProblem,
  roleIn,
  senderLabel,
  type Viewer,
  visibleTeams,
} from "../../server/access.ts";

const admin: Viewer = { userId: "u-admin", admin: true, secondFactor: true, teams: {} };
const adminWithoutSecondFactor: Viewer = { ...admin, secondFactor: false };
const member: Viewer = { userId: "u-member", admin: false, secondFactor: false, teams: { shop: "member", blog: "contributor" } };
const contributor: Viewer = { userId: "u-contributor", admin: false, secondFactor: false, teams: { shop: "contributor" } };

const TEAM_ABILITIES: Ability[] = ["team:overview", "team:board", "requests:all", "requests:send", "senders:names", "proposals:decide", "people:manage"];
const allowedOn = (viewer: Viewer | null, team?: string): Ability[] => TEAM_ABILITIES.filter((a) => can(viewer, a, team));

describe("an admin", () => {
  test("with the second factor does everything, on every team, members of it or not", () => {
    assert.deepEqual(allowedOn(admin, "shop"), TEAM_ABILITIES);
    assert.deepEqual(allowedOn(admin, "anything"), TEAM_ABILITIES);
    assert.equal(can(admin, "people:manage"), true);
    assert.equal(roleIn(admin, "shop"), "admin");
    assert.deepEqual(visibleTeams(admin, ["blog", "shop"]), ["blog", "shop"]);
  });

  test("without the second factor does nothing at all, and sees no team", () => {
    assert.equal(blockedAdmin(adminWithoutSecondFactor), true);
    assert.deepEqual(allowedOn(adminWithoutSecondFactor, "shop"), []);
    assert.equal(can(adminWithoutSecondFactor, "people:manage"), false);
    assert.equal(roleIn(adminWithoutSecondFactor, "shop"), null);
    assert.deepEqual(visibleTeams(adminWithoutSecondFactor, ["blog", "shop"]), []);
    // Even a team they'd belong to as a member.
    assert.deepEqual(allowedOn({ ...adminWithoutSecondFactor, teams: { shop: "member" } }, "shop"), []);
  });
});

describe("a member", () => {
  test("sees the board, journeys, the graph and every request, and sends requests", () => {
    assert.deepEqual(allowedOn(member, "shop"), ["team:overview", "team:board", "requests:all", "requests:send"]);
  });
  test("never sees names, decides proposals or manages people", () => {
    for (const ability of ["senders:names", "proposals:decide", "people:manage"] as const) assert.equal(can(member, ability, "shop"), false, ability);
    assert.equal(can(member, "people:manage"), false);
  });
  test("is only what their role is on each team, and nothing on others", () => {
    assert.deepEqual(allowedOn(member, "blog"), ["team:overview", "requests:send"]);
    assert.deepEqual(allowedOn(member, "other"), []);
    assert.deepEqual(visibleTeams(member, ["blog", "other", "shop"]), ["blog", "shop"]);
  });
  test("a second factor changes nothing for someone who isn't an admin", () => {
    assert.deepEqual(allowedOn({ ...member, secondFactor: true }, "shop"), allowedOn(member, "shop"));
  });
});

describe("a contributor", () => {
  test("sees the overview and sends requests, nothing more", () => {
    assert.deepEqual(allowedOn(contributor, "shop"), ["team:overview", "requests:send"]);
    assert.equal(can(contributor, "team:board", "shop"), false);
    assert.equal(can(contributor, "requests:all", "shop"), false);
    assert.equal(can(contributor, "proposals:decide", "shop"), false);
  });
  test("sees their own requests only", () => {
    assert.equal(canSeeRequest(contributor, "shop", { from: "s4" }, "s4"), true);
    assert.equal(canSeeRequest(contributor, "shop", { from: "s5" }, "s4"), false);
    assert.equal(canSeeRequest(contributor, "shop", { from: null }, "s4"), false);
    // Without a stakeholder record on the team, none.
    assert.equal(canSeeRequest(contributor, "shop", { from: "s4" }, null), false);
    // Nor on a team they aren't on, whatever the ids.
    assert.equal(canSeeRequest(contributor, "blog", { from: "s4" }, "s4"), false);
  });
});

test("members and admins see every request of the team; nobody signed out sees any", () => {
  assert.equal(canSeeRequest(member, "shop", { from: "s9" }, null), true);
  assert.equal(canSeeRequest(admin, "shop", { from: "s9" }, null), true);
  assert.equal(canSeeRequest(null, "shop", { from: "s9" }, "s9"), false);
  assert.equal(canSeeRequest(adminWithoutSecondFactor, "shop", { from: "s9" }, null), false);
});

test("nobody signed out may do anything", () => {
  assert.deepEqual(allowedOn(null, "shop"), []);
  assert.deepEqual(visibleTeams(null, ["shop"]), []);
});

test("a team name that is an object's own key in JavaScript is just a team nobody is on", () => {
  for (const team of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
    assert.equal(roleIn(member, team), null, team);
    assert.deepEqual(allowedOn(member, team), [], team);
  }
});

describe("who sent a request", () => {
  const sender = { id: "s3", name: "Ada Lovelace", email: "ada@example.com", role: "customer" };
  test("an admin sees the name and address", () => {
    assert.equal(senderLabel(admin, "shop", sender, null), "Ada Lovelace <ada@example.com> (customer)");
  });
  test("a member sees the role only", () => {
    assert.equal(senderLabel(member, "shop", sender, null), "customer");
  });
  test("the sender sees themselves", () => {
    assert.equal(senderLabel(contributor, "shop", sender, "s3"), "you");
  });
  test("an admin without the second factor sees no name", () => {
    assert.equal(senderLabel(adminWithoutSecondFactor, "shop", sender, null), "customer");
  });
  test("none at all", () => {
    assert.equal(senderLabel(admin, "shop", null, null), "no stakeholder");
  });
});

describe("what's accepted", () => {
  test("a request has a title of at most 200 characters and a body of at most 20,000", () => {
    assert.match(requestProblem("", "") ?? "", /title/);
    assert.match(requestProblem("   ", "body") ?? "", /title/);
    assert.equal(requestProblem("a".repeat(LIMITS.title), "b".repeat(LIMITS.body)), null);
    assert.match(requestProblem("a".repeat(LIMITS.title + 1), "") ?? "", /200/);
    assert.match(requestProblem("ok", "b".repeat(LIMITS.body + 1)) ?? "", /20,000/);
  });
  test("an approval may come with a note; the other decisions need one", () => {
    assert.equal(decisionProblem("approve", ""), null);
    for (const d of ["reject", "research", "escalate"] as const) {
      assert.notEqual(decisionProblem(d, " "), null, d);
      assert.equal(decisionProblem(d, "because"), null, d);
    }
    assert.notEqual(decisionProblem("approve", "x".repeat(LIMITS.note + 1)), null);
  });
  test("an invitation names an address, a person, a team and a role", () => {
    const good = { email: "ada@example.com", name: "Ada", team: "shop", role: "contributor", label: "customer" };
    assert.equal(invitationProblem(good), null);
    assert.notEqual(invitationProblem({ ...good, email: "ada" }), null);
    assert.notEqual(invitationProblem({ ...good, name: "" }), null);
    assert.notEqual(invitationProblem({ ...good, team: "../x" }), null);
    assert.notEqual(invitationProblem({ ...good, role: "admin" }), null);
    assert.notEqual(invitationProblem({ ...good, label: "x".repeat(LIMITS.label + 1) }), null);
  });
});
