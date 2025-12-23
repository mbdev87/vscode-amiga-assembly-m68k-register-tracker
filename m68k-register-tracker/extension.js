const vscode = require('vscode');

// m68k calling convention - scratch vs preserved regs
const SCRATCH_REGS = new Set(['D0', 'D1', 'A0', 'A1']);
const PRESERVED_DATA = ['D2', 'D3', 'D4', 'D5', 'D6', 'D7'];
const PRESERVED_ADDR = ['A2', 'A3', 'A4', 'A5', 'A6'];

// analyze register usage in subroutines
class RegisterAnalyzer {
    constructor() {
        this.touched = new Set();
        this.modified = new Set();
        this.saved = new Set();
    }

    // pull out register names from asm line
    extractRegisters(line) {
        // match d0-d7, a0-a7
        const matches = line.match(/\b[dDaA][0-7]\b/g);
        if (!matches) return [];
        return matches.map(r => r.toUpperCase());
    }

    // check if we're saving regs to stack
    parseStackSave(line) {
        // looking for movem.l d2-d7/a2-a6,-(sp) pattern
        const match = line.match(/movem\.[lw]\s+([^,]+),\s*-\(sp\)/i);
        if (!match) return [];

        const regList = match[1];
        const saved = new Set();

        // parse register ranges or individual regs
        const parts = regList.split('/');
        for (const part of parts) {
            const trimmed = part.trim();

            // handle range like d2-d7
            if (trimmed.includes('-')) {
                const [start, end] = trimmed.split('-').map(r => r.trim().toUpperCase());
                const type = start[0];
                const startNum = parseInt(start[1]);
                const endNum = parseInt(end[1]);

                for (let i = startNum; i <= endNum; i++) {
                    saved.add(`${type}${i}`);
                }
            } else {
                // single reg
                saved.add(trimmed.toUpperCase());
            }
        }

        return Array.from(saved);
    }

    // figure out if instruction writes to a register
    isModifying(line, reg) {
        // m68k is source,dest format
        // only care if reg is destination

        const trimmed = line.trim();

        if (trimmed.startsWith(';')) return false;

        // movem to stack is reading not writing
        if (trimmed.match(/movem.*-\(sp\)/i)) return false;

        // movem from stack IS writing
        const movemRestore = trimmed.match(/movem.*\(sp\)\+\s*,\s*(.+)/i);
        if (movemRestore) {
            return movemRestore[1].toUpperCase().includes(reg);
        }

        // two operand: dest is second one
        const twoOp = trimmed.match(/^\s*\w+\.[bwl]?\s+[^,]+,\s*(.+?)(?:;|$)/i);
        if (twoOp) {
            const dest = twoOp[1].trim();
            return dest.toUpperCase().includes(reg);
        }

        // single operand instructions that modify
        // NOTE: tst doesn't modify!
        const oneOpModify = trimmed.match(/^\s*(clr|neg|not|suba|adda|addq|subq|asl|asr|lsl|lsr|rol|ror)\.[bwl]?\s+(.+?)(?:;|$)/i);
        if (oneOpModify) {
            const dest = oneOpModify[2].trim();
            return dest.toUpperCase().includes(reg);
        }

        // tst, cmp just read
        if (trimmed.match(/^\s*(tst|cmp)\b/i)) {
            return false;
        }

        return false;
    }

    // main analysis function
    analyze(lines) {
        this.touched.clear();
        this.modified.clear();
        this.saved.clear();

        for (const line of lines) {
            const trimmed = line.trim();

            // skip comments and blanks
            if (!trimmed || trimmed.startsWith(';')) continue;

            // check for stack save first
            const savedRegs = this.parseStackSave(trimmed);
            if (savedRegs.length > 0) {
                savedRegs.forEach(r => this.saved.add(r));
                continue;
            }

            // grab all regs used in this line
            const regs = this.extractRegisters(trimmed);
            for (const reg of regs) {
                this.touched.add(reg);

                if (this.isModifying(trimmed, reg)) {
                    this.modified.add(reg);
                }
            }
        }

        return this.generateStatus();
    }

    // generate final status for each reg
    generateStatus() {
        const status = {};

        const allRegs = ['D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7',
                        'A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6'];

        for (const reg of allRegs) {
            if (!this.touched.has(reg)) {
                status[reg] = 'untouched';
            } else if (SCRATCH_REGS.has(reg)) {
                status[reg] = 'scratch';
            } else if (this.saved.has(reg)) {
                status[reg] = 'saved';
            } else if (this.modified.has(reg)) {
                // modified preserved reg without save = bad!
                status[reg] = 'unsafe';
            } else {
                // just reading from preserved reg is ok
                status[reg] = 'untouched';
            }
        }

        return status;
    }
}

// codelens provider to show register status
class RegisterCodeLensProvider {
    constructor() {
        this.analyzer = new RegisterAnalyzer();
    }

    provideCodeLenses(document, token) {
        const codeLenses = [];
        const text = document.getText();
        const lines = text.split('\n');

        // first pass - find which labels are actual functions (have rts/rte)
        const subroutineLabels = new Set();
        let currentLabel = null;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();

            if (line.match(/^[a-zA-Z_][a-zA-Z0-9_.]*:\s*$/)) {
                currentLabel = line.replace(':', '');
            }

            // found rts/rte? mark this label as a function
            if (currentLabel && line.match(/^\s*(rts|rte)\b/)) {
                subroutineLabels.add(currentLabel);
            }
        }

        // second pass - analyze the actual functions
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();

            if (line.match(/^[a-zA-Z_][a-zA-Z0-9_.]*:\s*$/)) {
                const labelName = line.replace(':', '');

                // skip non-functions
                if (!subroutineLabels.has(labelName)) {
                    continue;
                }

                // find where this function ends
                let endLine = i + 1;
                while (endLine < lines.length) {
                    const nextLine = lines[endLine].trim();
                    if (nextLine.match(/^[a-zA-Z_][a-zA-Z0-9_.]*:\s*$/) ||
                        nextLine.match(/^\s*rts\b/) ||
                        nextLine.match(/^\s*rte\b/)) {
                        break;
                    }
                    endLine++;
                }

                // analyze register usage in this function
                const subroutineLines = lines.slice(i + 1, endLine + 1);
                const status = this.analyzer.analyze(subroutineLines);

                // create codelens entries (multiple lines stacked)
                const range = new vscode.Range(i, 0, i, 0);
                const formatted = this.formatRegisterStatus(status);

                for (const line of formatted) {
                    const lens = new vscode.CodeLens(range);
                    lens.command = {
                        title: line,
                        command: ''
                    };
                    codeLenses.push(lens);
                }
            }
        }

        return codeLenses;
    }

    // format register status for display
    formatRegisterStatus(status) {
        const groups = {
            untouched: [],
            scratch: [],
            saved: [],
            unsafe: []
        };

        for (const [reg, state] of Object.entries(status)) {
            if (state === 'untouched') groups.untouched.push(reg);
            else if (state === 'scratch') groups.scratch.push(reg);
            else if (state === 'saved') groups.saved.push(reg);
            else if (state === 'unsafe') groups.unsafe.push(reg);
        }

        // split data vs addr regs
        const separateByType = (regs) => {
            const data = regs.filter(r => r[0] === 'D');
            const addr = regs.filter(r => r[0] === 'A');
            return { data, addr };
        };

        let lines = [];

        // data registers line
        let dataParts = [];
        const scratchData = separateByType(groups.scratch).data;
        const savedData = separateByType(groups.saved).data;
        const unsafeData = separateByType(groups.unsafe).data;

        if (scratchData.length > 0) {
            dataParts.push(`🟡Scratch:${scratchData.join(',')}`);
        }
        if (savedData.length > 0) {
            dataParts.push(`🟢Saved:${savedData.join(',')}`);
        }
        if (unsafeData.length > 0) {
            dataParts.push(`🔴UNSAFE:${unsafeData.join(',')}`);
        }

        if (dataParts.length > 0) {
            lines.push('🧮 DATA: ' + dataParts.join(' '));
        }

        // address registers line
        let addrParts = [];
        const scratchAddr = separateByType(groups.scratch).addr;
        const savedAddr = separateByType(groups.saved).addr;
        const unsafeAddr = separateByType(groups.unsafe).addr;

        if (scratchAddr.length > 0) {
            addrParts.push(`🟡Scratch:${scratchAddr.join(',')}`);
        }
        if (savedAddr.length > 0) {
            addrParts.push(`🟢Saved:${savedAddr.join(',')}`);
        }
        if (unsafeAddr.length > 0) {
            addrParts.push(`🔴UNSAFE:${unsafeAddr.join(',')}`);
        }

        if (addrParts.length > 0) {
            lines.push('📍 ADDR: ' + addrParts.join(' '));
        }

        if (lines.length === 0) {
            return ['M68K Registers: none used'];
        }

        return lines;
    }
}

// decoration type for highlighting unsafe lines
let unsafeRegisterDecorationType;

// update decorations in active editor
function updateDecorations(editor) {
    if (!editor) return;

    const document = editor.document;
    const text = document.getText();
    const lines = text.split('\n');

    const analyzer = new RegisterAnalyzer();
    const unsafeLines = [];

    // find all subroutines first
    const subroutineLabels = new Set();
    let currentLabel = null;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.match(/^[a-zA-Z_][a-zA-Z0-9_.]*:\s*$/)) {
            currentLabel = line.replace(':', '');
        }
        if (currentLabel && line.match(/^\s*(rts|rte)\b/)) {
            subroutineLabels.add(currentLabel);
        }
    }

    // check each subroutine for unsafe reg usage
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        if (line.match(/^[a-zA-Z_][a-zA-Z0-9_.]*:\s*$/)) {
            const labelName = line.replace(':', '');
            if (!subroutineLabels.has(labelName)) continue;

            // find where function ends
            let endLine = i + 1;
            while (endLine < lines.length) {
                const nextLine = lines[endLine].trim();
                if (nextLine.match(/^[a-zA-Z_][a-zA-Z0-9_.]*:\s*$/) ||
                    nextLine.match(/^\s*rts\b/) ||
                    nextLine.match(/^\s*rte\b/)) {
                    break;
                }
                endLine++;
            }

            // run analysis on this function
            const subroutineLines = lines.slice(i + 1, endLine + 1);
            analyzer.analyze(subroutineLines);

            // find lines that modify unsaved regs
            for (let j = i + 1; j <= endLine; j++) {
                const codeLine = lines[j];
                const regs = analyzer.extractRegisters(codeLine);

                for (const reg of regs) {
                    if (analyzer.modified.has(reg) && !analyzer.saved.has(reg) &&
                        !SCRATCH_REGS.has(reg)) {
                        // found one! mark it
                        const range = new vscode.Range(j, 0, j, codeLine.length);
                        const regType = reg[0];
                        const example = regType === 'D'
                            ? `movem.l d2-d7,-(sp)  ; Save at function start\n    ...\n    movem.l (sp)+,d2-d7  ; Restore before rts`
                            : `movem.l a2-a6,-(sp)  ; Save at function start\n    ...\n    movem.l (sp)+,a2-a6  ; Restore before rts`;

                        unsafeLines.push({
                            range,
                            hoverMessage: new vscode.MarkdownString(
                                `⚠️ **Register ${reg} modified without being saved to stack!**\n\n` +
                                `Preserved registers (d2-d7, a2-a6) must be saved before modification.\n\n` +
                                `**Fix:**\n\`\`\`m68k\n${example}\n\`\`\``
                            )
                        });
                        break; // one per line is enough
                    }
                }
            }
        }
    }

    editor.setDecorations(unsafeRegisterDecorationType, unsafeLines);
}

// extension entry point
function activate(context) {
    console.log('M68K Register Tracker activated');

    const provider = new RegisterCodeLensProvider();

    // file types we support
    const selector = [
        { language: 'm68k', scheme: 'file' },
        { pattern: '**/*.s', scheme: 'file' },
        { pattern: '**/*.asm', scheme: 'file' }
    ];

    // setup decoration style for unsafe lines
    unsafeRegisterDecorationType = vscode.window.createTextEditorDecorationType({
        isWholeLine: false,
        overviewRulerColor: 'rgba(255, 0, 0, 0.8)',
        overviewRulerLane: vscode.OverviewRulerLane.Right,
        light: {
            backgroundColor: 'rgba(255, 0, 0, 0.05)',
            borderColor: 'rgba(255, 0, 0, 0.2)',
            border: '1px solid'
        },
        dark: {
            backgroundColor: 'rgba(255, 0, 0, 0.1)',
            borderColor: 'rgba(255, 0, 0, 0.3)',
            border: '1px solid'
        }
    });

    const disposable = vscode.languages.registerCodeLensProvider(selector, provider);
    context.subscriptions.push(disposable);

    // hook up decoration updates
    let activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
        updateDecorations(activeEditor);
    }

    vscode.window.onDidChangeActiveTextEditor(editor => {
        activeEditor = editor;
        if (editor) {
            updateDecorations(editor);
        }
    }, null, context.subscriptions);

    vscode.workspace.onDidChangeTextDocument(event => {
        if (activeEditor && event.document === activeEditor.document) {
            updateDecorations(activeEditor);
        }
    }, null, context.subscriptions);
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
};
