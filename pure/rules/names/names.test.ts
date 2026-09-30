// Each test plants a fool from the review of PR #66: a name that looks like a check and never runs.
import { describe, expect, test } from "bun:test";
import { arrivalNames, quintNames, testFileNames } from "./names.ts";

const titlesOf = (source: string): readonly string[] =>
  testFileNames("rig", "pure/diff/x/a.test.ts", source).filter((each) => each.kind === "title").map((each) => each.text);

const fileNamesOf = (file: string, source: string): readonly string[] =>
  testFileNames("contract", file, source).filter((each) => each.kind === "file").map((each) => each.text);

const solidityNames = (source: string): readonly string[] =>
  testFileNames("contract", "contracts/test/foundry/x/A.t.sol", source)
    .filter((each) => each.kind === "function")
    .map((each) => each.text);

describe("TypeScript tests count only when they run", () => {
  test("a plain test counts, and so does .only", () => {
    expect(titlesOf(`describe("R-A block", () => { it("R-B leaf", () => {}); it.only("R-C only", () => {}); });`)).toEqual(["R-A block", "R-B leaf", "R-C only"]);
  });

  test("it.skip, test.todo, it.skipIf and xit do not count", () => {
    const source = `it.skip("R-S1", () => {}); test.todo("R-S2"); test.skipIf(true)("R-S3", () => {}); xit("R-S4", () => {});`;
    expect(titlesOf(source)).toEqual([]);
  });

  test("describe.skip drops itself and the tests inside it", () => {
    expect(titlesOf(`describe.skip("R-S5 block", () => { it("R-S6 inner", () => {}); });`)).toEqual([]);
  });

  test("an empty test file named after a rule carries nothing", () => {
    expect(fileNamesOf("contracts/test/vm/x/r-empty.test.ts", "// nothing here\n")).toEqual([]);
    expect(fileNamesOf("contracts/test/vm/x/r-real.test.ts", `it("a test", () => {});`)).toEqual(["r-real"]);
  });

  test("a comment right after code, with or without a space, hides the call", () => {
    expect(titlesOf(`foo();//it("R-C1 nospace", () => {});`)).toEqual([]);
    expect(titlesOf(`foo(); // it("R-C2 space", () => {});`)).toEqual([]);
    expect(titlesOf(`foo(); /* it("R-C3 block", () => {}); */`)).toEqual([]);
  });

  test("a string literal that contains a call is not a call", () => {
    expect(titlesOf(`const s = 'it("R-L1 inside", 1)'; const t = "test('R-L2', 1)";`)).toEqual([]);
  });

  test("a // inside a string is not a comment, so the test after it still counts", () => {
    expect(titlesOf(`const u = "http://x"; it("R-U1 after a url", () => {});`)).toEqual(["R-U1 after a url"]);
    expect(titlesOf(`it("R-U2 see http://x for details", () => {});`)).toEqual(["R-U2 see http://x for details"]);
  });

  test("member calls are not tests: re.test(...) and foo.it(...)", () => {
    expect(titlesOf(`const re = /x/; re.test("R-M1 regex"); foo.it("R-M2 method");`)).toEqual([]);
  });

  test("a call that no runner reaches is not a test: inside if (false) or an unused helper", () => {
    expect(titlesOf(`if (false) { it("R-D1 dead", () => {}); }`)).toEqual([]);
    expect(titlesOf(`const unused = () => { test("R-D2 unused", () => {}); };`)).toEqual([]);
    expect(titlesOf(`if (false) { describe("R-D3 x", () => { it("R-D4 y", () => {}); }); }`)).toEqual([]);
  });

  test("a title wrapped in a call, describe(seedTag(\"...\"), ...), is still the title", () => {
    expect(titlesOf(`describe(seedTag("R-W1 wrapped"), () => { test("R-W2 leaf", () => {}); });`)).toEqual(["R-W1 wrapped", "R-W2 leaf"]);
  });

  test("tests nested in describes, with function or arrow callbacks, count", () => {
    const source = `describe("R-N1", function () { describe("R-N2", async () => { it("R-N3", () => {}); }); });`;
    expect(titlesOf(source)).toEqual(["R-N1", "R-N2", "R-N3"]);
  });
});

describe("Foundry names count only when forge runs them", () => {
  const contract = (body: string, header = "contract A is Test"): string => `${header} {\n${body}\n}`;

  test("public and external test and invariant functions in a concrete contract count", () => {
    const source = contract(`function test_R_A() public {}\nfunction testFuzz_R_B(uint x) external {}\nfunction invariant_R_C() public view {}`);
    expect(solidityNames(source)).toEqual(["test_R_A", "testFuzz_R_B", "invariant_R_C"]);
  });

  test("internal and private functions do not count", () => {
    expect(solidityNames(contract(`function test_R_I() internal {}\nfunction test_R_P() private {}`))).toEqual([]);
  });

  test("a function in an abstract contract does not count", () => {
    expect(solidityNames(contract(`function test_R_AB() public {}`, "abstract contract A is Test"))).toEqual([]);
  });

  test("check and prove prefixes are not forge tests", () => {
    expect(solidityNames(contract(`function checkR_X() public {}\nfunction prove_R_Y() public {}`))).toEqual([]);
  });

  test("a comment tail without a space, a natspec line and a string do not hide or make functions", () => {
    const source = `contract A is Test {}//function test_R_T() public {}\n/// function test_R_N() public {}\ncontract B is Test { string s = "function test_R_S() public {}"; }`;
    expect(solidityNames(source)).toEqual([]);
  });

  test("a contract with no test functions carries neither its file name nor its contract name", () => {
    const names = testFileNames("contract", "contracts/test/foundry/x/Helper.t.sol", "contract Helper is Test { function setUp() public {} }");
    expect(names.map((each) => each.text)).toEqual([]);
  });
});

describe("Arrival names", () => {
  test("a property after a comment with no space, and one inside a string, are not properties", () => {
    const source = `(foo);(property "R-P1 comment" (w) ok)\n(define s "(property \\"R-P2 string\\" x)")\n(property "R-P3 real" (w) ok)`;
    expect(arrivalNames("spec/x/a.scm", source).filter((each) => each.kind === "property").map((each) => each.text)).toEqual(["R-P3 real"]);
  });

  test("a semicolon inside a property string does not end the string", () => {
    const source = `(property "R-P4 holds; then more" (w) ok)`;
    expect(arrivalNames("spec/x/a.scm", source).filter((each) => each.kind === "property").map((each) => each.text)).toEqual(["R-P4 holds; then more"]);
  });
});

describe("Quint names", () => {
  const quint = (source: string): readonly string[] => quintNames("spec/quint/a.qnt", source).map((each) => each.text);

  test("a run is a check; a val or def or action is not", () => {
    expect(quint(`run R_A_test = init.then(step)\nval R_B = 1\npure def R_C(x) = x\naction R_D = all {}`)).toEqual(["R_A_test"]);
  });

  test("a run in a comment is not a check", () => {
    expect(quint(`// run R_E_test = 1\n/* run R_F_test = 1 */\nrun R_G_test = 1`)).toEqual(["R_G_test"]);
  });

  test("an invariant that a check script passes to quint counts", () => {
    const names = quintNames("spec/quint/check.sh", "quint run --invariant credit_holds x.qnt\nquint run --invariant=agreed y.qnt");
    expect(names.map((each) => each.text)).toEqual(["credit_holds", "agreed"]);
  });
});
