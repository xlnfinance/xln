"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g;
    return g = { next: verb(0), "throw": verb(1), "return": verb(2) }, typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
var react_1 = require("react");
var lucide_react_1 = require("lucide-react");
var alert_1 = require("@/components/ui/alert");
var tabs_1 = require("@/components/ui/tabs");
var card_1 = require("@/components/ui/card");
var input_1 = require("@/components/ui/input");
var button_1 = require("@/components/ui/button");
var label_1 = require("@/components/ui/label");
var XLNWebUI = function () {
    var _a = (0, react_1.useState)(null), user = _a[0], setUser = _a[1];
    var _b = (0, react_1.useState)([]), channels = _b[0], setChannels = _b[1];
    var _c = (0, react_1.useState)(null), selectedChannel = _c[0], setSelectedChannel = _c[1];
    var _d = (0, react_1.useState)(''), message = _d[0], setMessage = _d[1];
    var _e = (0, react_1.useState)(''), amount = _e[0], setAmount = _e[1];
    var _f = (0, react_1.useState)(''), recipient = _f[0], setRecipient = _f[1];
    var _g = (0, react_1.useState)([]), history = _g[0], setHistory = _g[1];
    (0, react_1.useEffect)(function () {
        // Simulating user login and channel fetching
        var fetchData = function () { return __awaiter(void 0, void 0, void 0, function () {
            return __generator(this, function (_a) {
                // Replace with actual API calls
                setUser({ address: '0x1234...5678', balance: '10000' });
                setChannels([
                    {
                        id: '1',
                        peer: '0xabcd...efgh',
                        chainId: 1,
                        tokenId: 1,
                        derivedDelta: {
                            delta: 500n,
                            collateral: 1000n,
                            inCollateral: 500n,
                            outCollateral: 500n,
                            inOwnCredit: 0n,
                            outPeerCredit: 0n,
                            inAllowance: 100n,
                            outAllowance: 100n,
                            totalCapacity: 2000n,
                            ownCreditLimit: 500n,
                            peerCreditLimit: 500n,
                            inCapacity: 900n,
                            outCapacity: 900n,
                        }
                    },
                    {
                        id: '2',
                        peer: '0x9876...5432',
                        chainId: 1,
                        tokenId: 2,
                        derivedDelta: {
                            delta: -200n,
                            collateral: 800n,
                            inCollateral: 800n,
                            outCollateral: 0n,
                            inOwnCredit: 200n,
                            outPeerCredit: 0n,
                            inAllowance: 50n,
                            outAllowance: 50n,
                            totalCapacity: 1600n,
                            ownCreditLimit: 400n,
                            peerCreditLimit: 400n,
                            inCapacity: 1350n,
                            outCapacity: 350n,
                        }
                    },
                ]);
                setHistory([
                    { type: 'Block', number: 1, timestamp: '2023-07-21 10:00:00', transitions: 2 },
                    { type: 'Transition', action: 'Payment', amount: '100', timestamp: '2023-07-21 09:55:00' },
                    { type: 'Transition', action: 'AddSubchannel', chainId: 1, timestamp: '2023-07-21 09:50:00' },
                ]);
                return [2 /*return*/];
            });
        }); };
        fetchData();
    }, []);
    var handleSendMessage = function () {
        if (selectedChannel && message) {
            console.log("Sending message to ".concat(selectedChannel.peer, ": ").concat(message));
            setMessage('');
        }
    };
    var handlePayment = function () {
        if (amount && recipient) {
            console.log("Sending payment of ".concat(amount, " to ").concat(recipient));
            setAmount('');
            setRecipient('');
        }
    };
    var handleCreateChannel = function () {
        console.log('Creating new channel');
        // Implement channel creation logic
    };
    var handleSwap = function () {
        console.log('Initiating token swap');
        // Implement token swap logic
    };
    var renderCollateralLayout = function (channel) {
        var derivedDelta = channel.derivedDelta;
        var totalWidth = Number(derivedDelta.totalCapacity);
        var collateralWidth = (Number(derivedDelta.collateral) / totalWidth) * 100;
        var ownCreditWidth = (Number(derivedDelta.ownCreditLimit) / totalWidth) * 100;
        var peerCreditWidth = (Number(derivedDelta.peerCreditLimit) / totalWidth) * 100;
        var deltaPosition = ((Number(derivedDelta.delta) + Number(derivedDelta.ownCreditLimit)) / totalWidth) * 100;
        return (react_1.default.createElement("div", { className: "relative w-full h-8 bg-gray-200 rounded-full overflow-hidden flex" },
            react_1.default.createElement("div", { className: "bg-red-500", style: { width: "".concat(ownCreditWidth, "%") } }),
            react_1.default.createElement("div", { className: "bg-green-500", style: { width: "".concat(collateralWidth, "%") } }),
            react_1.default.createElement("div", { className: "bg-red-500", style: { width: "".concat(peerCreditWidth, "%") } }),
            react_1.default.createElement("div", { className: "absolute h-full border-l-2 border-black", style: { left: "".concat(deltaPosition, "%") } })));
    };
    return (react_1.default.createElement("div", { className: "container mx-auto p-4" },
        react_1.default.createElement("h1", { className: "text-3xl font-bold mb-4" }, "XLN Wallet"),
        user && (react_1.default.createElement(alert_1.Alert, { className: "mb-4" },
            react_1.default.createElement(lucide_react_1.Camera, { className: "h-4 w-4" }),
            react_1.default.createElement(alert_1.AlertTitle, null, "Connected"),
            react_1.default.createElement(alert_1.AlertDescription, null,
                "Address: ",
                user.address,
                " | Balance: ",
                user.balance,
                " XLN"))),
        react_1.default.createElement("div", { className: "grid grid-cols-1 md:grid-cols-3 gap-4 mb-4" },
            react_1.default.createElement(card_1.Card, null,
                react_1.default.createElement(card_1.CardHeader, null,
                    react_1.default.createElement(card_1.CardTitle, null, "Channels")),
                react_1.default.createElement(card_1.CardContent, null,
                    react_1.default.createElement("ul", { className: "space-y-2" }, channels.map(function (channel) { return (react_1.default.createElement("li", { key: channel.id, className: "p-2 rounded cursor-pointer ".concat((selectedChannel === null || selectedChannel === void 0 ? void 0 : selectedChannel.id) === channel.id ? 'bg-blue-100' : 'bg-gray-100'), onClick: function () { return setSelectedChannel(channel); } },
                        react_1.default.createElement("p", { className: "font-semibold" },
                            "Peer: ",
                            channel.peer),
                        react_1.default.createElement("p", null,
                            "Chain ID: ",
                            channel.chainId,
                            ", Token ID: ",
                            channel.tokenId),
                        renderCollateralLayout(channel))); }))),
                react_1.default.createElement(card_1.CardFooter, null,
                    react_1.default.createElement(button_1.Button, { onClick: handleCreateChannel, className: "w-full" },
                        react_1.default.createElement(lucide_react_1.PlusCircle, { className: "mr-2 h-4 w-4" }),
                        " Create Channel"))),
            react_1.default.createElement(card_1.Card, { className: "col-span-2" },
                react_1.default.createElement(card_1.CardHeader, null,
                    react_1.default.createElement(card_1.CardTitle, null, "Channel Details")),
                react_1.default.createElement(card_1.CardContent, null, selectedChannel ? (react_1.default.createElement(tabs_1.Tabs, { defaultValue: "view" },
                    react_1.default.createElement(tabs_1.TabsList, { className: "grid w-full grid-cols-3" },
                        react_1.default.createElement(tabs_1.TabsTrigger, { value: "view" },
                            react_1.default.createElement(lucide_react_1.BarChart2, { className: "mr-2 h-4 w-4" }),
                            " View"),
                        react_1.default.createElement(tabs_1.TabsTrigger, { value: "history" },
                            react_1.default.createElement(lucide_react_1.Clock, { className: "mr-2 h-4 w-4" }),
                            " History"),
                        react_1.default.createElement(tabs_1.TabsTrigger, { value: "action" },
                            react_1.default.createElement(lucide_react_1.PlayCircle, { className: "mr-2 h-4 w-4" }),
                            " Action")),
                    react_1.default.createElement(tabs_1.TabsContent, { value: "view" },
                        react_1.default.createElement("div", { className: "space-y-2" },
                            react_1.default.createElement("p", null,
                                react_1.default.createElement("strong", null, "Peer:"),
                                " ",
                                selectedChannel.peer),
                            react_1.default.createElement("p", null,
                                react_1.default.createElement("strong", null, "Chain ID:"),
                                " ",
                                selectedChannel.chainId),
                            react_1.default.createElement("p", null,
                                react_1.default.createElement("strong", null, "Token ID:"),
                                " ",
                                selectedChannel.tokenId),
                            react_1.default.createElement("p", null,
                                react_1.default.createElement("strong", null, "Collateral:"),
                                " ",
                                selectedChannel.derivedDelta.collateral.toString()),
                            react_1.default.createElement("p", null,
                                react_1.default.createElement("strong", null, "Delta:"),
                                " ",
                                selectedChannel.derivedDelta.delta.toString()),
                            react_1.default.createElement("p", null,
                                react_1.default.createElement("strong", null, "Own Credit Limit:"),
                                " ",
                                selectedChannel.derivedDelta.ownCreditLimit.toString()),
                            react_1.default.createElement("p", null,
                                react_1.default.createElement("strong", null, "Peer Credit Limit:"),
                                " ",
                                selectedChannel.derivedDelta.peerCreditLimit.toString()))),
                    react_1.default.createElement(tabs_1.TabsContent, { value: "history" },
                        react_1.default.createElement("ul", { className: "space-y-2" }, history.map(function (item, index) { return (react_1.default.createElement("li", { key: index, className: "bg-gray-100 p-2 rounded" },
                            react_1.default.createElement("p", null,
                                react_1.default.createElement("strong", null,
                                    item.type,
                                    ":"),
                                " ",
                                item.action || "Block ".concat(item.number)),
                            react_1.default.createElement("p", null,
                                react_1.default.createElement("strong", null, "Timestamp:"),
                                " ",
                                item.timestamp),
                            item.amount && react_1.default.createElement("p", null,
                                react_1.default.createElement("strong", null, "Amount:"),
                                " ",
                                item.amount),
                            item.transitions && react_1.default.createElement("p", null,
                                react_1.default.createElement("strong", null, "Transitions:"),
                                " ",
                                item.transitions))); }))),
                    react_1.default.createElement(tabs_1.TabsContent, { value: "action" },
                        react_1.default.createElement("div", { className: "space-y-4" },
                            react_1.default.createElement("div", null,
                                react_1.default.createElement(label_1.Label, { htmlFor: "message" }, "Send Message"),
                                react_1.default.createElement("div", { className: "flex mt-1" },
                                    react_1.default.createElement(input_1.Input, { id: "message", value: message, onChange: function (e) { return setMessage(e.target.value); }, placeholder: "Enter message", className: "flex-grow" }),
                                    react_1.default.createElement(button_1.Button, { onClick: handleSendMessage, className: "ml-2" },
                                        react_1.default.createElement(lucide_react_1.Send, { className: "mr-2 h-4 w-4" }),
                                        " Send"))),
                            react_1.default.createElement("div", null,
                                react_1.default.createElement(label_1.Label, { htmlFor: "amount" }, "Make Payment"),
                                react_1.default.createElement("div", { className: "flex mt-1" },
                                    react_1.default.createElement(input_1.Input, { id: "amount", value: amount, onChange: function (e) { return setAmount(e.target.value); }, placeholder: "Amount", className: "flex-grow" }),
                                    react_1.default.createElement(input_1.Input, { value: recipient, onChange: function (e) { return setRecipient(e.target.value); }, placeholder: "Recipient address", className: "flex-grow ml-2" }),
                                    react_1.default.createElement(button_1.Button, { onClick: handlePayment, className: "ml-2" },
                                        react_1.default.createElement(lucide_react_1.Send, { className: "mr-2 h-4 w-4" }),
                                        " Pay"))),
                            react_1.default.createElement(button_1.Button, { onClick: handleSwap, className: "w-full" },
                                react_1.default.createElement(lucide_react_1.ArrowLeftRight, { className: "mr-2 h-4 w-4" }),
                                " Initiate Swap"))))) : (react_1.default.createElement("p", null, "Select a channel to view details and perform actions.")))))));
};
exports.default = XLNWebUI;
