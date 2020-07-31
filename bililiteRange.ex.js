(function(undefined){

/*********************** the actual ex plugin *********************************/
bililiteRange.ex = {}; // namespace for exporting utility functions

const exkey = Symbol(); // marker that an element has been processed already

bililiteRange.createOption ('stdout', {value: console.log, enumerable: false});
bililiteRange.createOption ('stderr', {value: console.error, enumerable: false});
bililiteRange.createOption ('reader', {
	value: async (file, dir) => localStorage.getItem(file)
});
bililiteRange.createOption ('writer', {
	value: async (text, file, dir) => localStorage.setItem(file, text)
});
// to use AJAX (you would probably want to handle HTTP errors, which still resolve, with response.ok != true):
// range.data.reader = async (file, dir) => (await fetch(file)).text();
// range.data.writer = async (text, file, dir) => await fetch(file, {method: 'POST', body: text});
// to use jQuery:
// range.data.reader = async (file, dir) => $.get(file);
// range.data.writer = async (text, file, dir) => $.post(file, {text: text});
bililiteRange.createOption ('savestatus', { monitored: true, value: 'clean' });

bililiteRange.prototype.executor = function (command){
	// returns a function that will run commandstring (if not defined, then will run whatever command is passed in when executed)
	return text => this.bounds('selection').
	 ex(command || text, '%%').
	 select().
	 scrollIntoView().
	 element().
	 focus();
};

bililiteRange.prototype.ex = function (commandstring = '', defaultaddress = '.'){
	const data = this.data;
	if (!this.element[exkey]){
		this.element[exkey] = true;
		this.initUndo();
		data.directory = this.window.location.protocol + '//' + this.window.location.hostname;
		data.file = window.location.pathname;
		data.savestatus = 'clean';
		this.listen ('input', evt => data.savestatus = 'dirty');
		data.marks = {
			"'": this.clone().live(), // this will record the last position in the text
			"''": this.clone().live() // this records the current position; just so it can be copied into ' above
		};
	}else{
		// update the marks
		let b = this.bounds(), lastb = data.marks["''"].bounds();
		if (b[0] != lastb[0] || b[1] != lastb[1]){
			data.marks["'"].bounds(lastb);
			data.marks["''"].bounds(b);
		}
	}
	// actually do the command
	commandstring = commandstring.replace(/^:+/,''); // ignore initial colons that were likely accidentally typed.
	try{
		splitCommands(commandstring, '|').forEach(function(command){
			let parsed = parseCommand(command, defaultaddress);
			interpretAddresses(this, parsed.addresses, data);
			parsed.command.call(this, parsed.parameter, parsed.variant);
		}, this);	
		this.dispatch({type: 'excommand', command: commandstring, range: this});
	}catch(err){
		this.data.stderr(err);
	}
	return this; // allow for chaining
};

var registers = bililiteRange.ex.registers = []; // the delete register is a stack, with 0 the most recent (use shift rather than pop)

/*********************** command completion *********************************/

function commandCompletion(command){
	var ret = (function(){
		if (commands[command]) return commands[command];
		command = command.toLowerCase();
		for (var trialCommand in commands){
			if (trialCommand.substr(0,command.length) == command) return commands[trialCommand];
		}
		throw new Error(command+" not defined");
	})();
	if (typeof ret == 'string') return commandCompletion(ret); // look for synonyms; beware of infinite loops!
	return ret;
}

/*********************** separating a command line into individual commands *********************************/
function splitCommands(commandLine, splitter = '|'){
	// need to be fancy about the | in regexps and strings; rather than try to make a monster regexp, use a simple parser
	var commands = [];
	var delims = /[/"]/; // regular expressions and strings
	var escaper = /\\/;
	for (var i = 0; i < commandLine.length; ++i){
		if (commandLine.substr(i, splitter.length) == splitter){
			commands.push (commandLine.slice(0, i));
			commandLine = commandLine.slice(i+splitter.length);
			i = -1; // restart the loop
			continue;
		}
		var c = commandLine.charAt(i);
		if (escaper.test(c)) ++i;
		if (delims.test(c)){
			// scan forward until the end of the string
			for (var j = i+1; j <= commandLine.length; ++j){
				var d = commandLine.charAt(j);
				if (d === '') {
					// fell off the end; we will close the string
					commandLine += c;
					d = c;
				}
				if (escaper.test(d)) ++j;
				if (c == d){
					i = j;
					break;
				}
			}
		}
	}
	commands.push(commandLine); // the rest of the line
	commands = commands.filter ( item => item ); // remove empty strings
	return commands;
}

bililiteRange.ex.splitCommands = splitCommands;

/*********************** parsing individual commands *********************************/
// create a regular expression to cover all possible address indicators.
// Rather than write the whole ugly thing out, synthesize it.
var REflags = 'igmwIMW'; // valid flags for regular expressions (I and M mean not i and m when they are the default, and w means wrap, overriding
// the state of wrapscan; W means no wrapping
function bslash(s) {return s.replace('\\', '\\\\')} // need to double-escape backslashes
var addressRE = new RegExp('^\\s*' + // allow whitespace at the beginning
	'('+[
		'%%', // my extension to mean "current range"
		'[.\\$%]', // single character addresses
		'\\d+', // line numbers
		"'['a-z]", // marks
		bslash("\\&?[/?]"), // special regexps: \/, \&\, \?, \&?
		// forward (/ delimited) regexps, a slash followed by some (escaped character or a non slash) ended with a slash, possibly preceded with a question mark
		'\\??'+bslash('/(?:\\.|[^/])*/['+REflags+']*')
	].join('|')+')'
);

// command id's in the real ex are letters and = & ~ > < 
var idRE = /^\s*(!|[a-zA-Z=&~><]+)/; // a single exclamation point is a legal command
var aUnicode = 'a'.charCodeAt(0);
function encodeID (c){
	// encodes a single character in base-26 (a-z) numbers preceded by '&'; sort of like encodeURI with '%'s
	// but with characters legal in ex commands
	function encode(x) {
		if (x < 26) return String.fromCharCode(x + aUnicode);
		return encode(x/26) + encode(x%26);
	};
	return '&' + encode(c.charCodeAt(0));
}
bililiteRange.ex.toID = function (s){
	// creates a legal id from an arbitrary string. Since I use sendkeys/keymap, I special-case those characters
	return s.replace(/./g, function (c){
		if (idRE.test(c) && c != '!') return c; // don't include ! in id's
		return {
			'-': '~',
			'%': 'alt~',
			'^': 'ctl~',
			'+': 'shift~',
			'{': '<',
			'}': '>'
		}[c] || encodeID(c) ;
	});
}

function parseCommand(command, defaultaddress){
	return {
		addresses: parseAddresses(),
		command: commandCompletion(parseCommandWord()),
		variant: parseVariant(),
		parameter: parseParameter()
	};
	
	function parseAddresses(){
		var addresses = [defaultaddress];
		// basic addresses
		command = command.replace(addressRE, function(match, c){
			addresses = [c];
			return '';
		});
		// relative addresses
		command = command.replace(/^\s*[-+\d]+/, function (match){
			addresses[0] += match;
			return '';
		});
		// a comma separates addresses
		if (/^\s*([,;])\s*/.test(command)){
			command = command.replace(/^\s*([,;])\s*/, '');
			if (RegExp.$1 == ';') addresses.push(';'); // need to track semicolons since they change the value of '.'
			addresses.push.apply(addresses, parseAddresses()); // recursively parse the whole list
		}
		return addresses;
	}

	function parseCommandWord(){
		if (/^\s*$/.test(command)) return 'print'; // blank line just goes to the addressed line, which is what we do with print
		var ret;
		command = command.replace(idRE, function (match, c){
			ret = c;
			return '';
		});
		if (!ret) throw new Error("No command string");
		return ret;
	}
	function parseVariant(){
		var variant = false;
		command = command.replace(/^\s*!/, function (){
			variant = true;
			return '';
		});
		return variant;
	}
	function parseParameter(){
		return (string(command));
	}
}

function string(text){
	// we use JSON strings if it is necessary to include special characters
	if (text === undefined) return '';
	text = text.trim();
	if (text.charAt(0) == '"') text = JSON.parse(text);
	return text;
}
bililiteRange.ex.string = string; // export it

/*********************** turn an array of address descriptions into an actual range *********************************/
var lastRE = /(?:)/; // blank RE's refer to this
function interpretAddresses (rng, addresses){
	// %% is the current range. If it is used by itself, don't change the range (or use line-based addressing)
	if (addresses.length == 1 && addresses[0] == "%%") return;
	const data = rng.data;
	var lines = [];
	var currLine = rng.line();
	addresses.forEach(function(s){
		var offset = 0;
		s = s.replace(/[-+\d]+$/, function (match){
			offset = interpretOffset(match);
			return '';
		});
		if (s.charAt(0) == '/'){
			var re = createRE(s, data.ignorecase); // TODO: use bililiteRange.RegExp
			let line = rng.bounds('EOL').bounds(re).line()+offset;
			lines.push(line);
		}else if (s.charAt(0) == '?'){
			// since having ? as a delimiter wreaks havoc with Javascript RE's, use ?/....../
			re = createRE(s.slice(1), data.ignorecase);
			lines.push(rng.bounds('BOL').bounds(re, 'b').bounds('EOL').line()+offset);
		}else if (s.charAt(0) == "'"){
			var mark = data.marks[s.slice(1)];
			if (mark){
				var these = mark.lines();
				lines.push(these[0]);
				if (these[0] != these[1]) lines.push(these[1]);
			}else{
				throw new Error('Mark '+s.slice(1)+' not defined');
			}
		}else if (/\d+/.test(s)){
			lines.push(rng.bounds('line', s).bounds('EOL').line()+offset); // make sure we go to the end of the line
		}else if (s == '.'){
			lines.push(currLine+offset);
		}else if (s == '%%'){
			var rnglines = rng.lines();
			lines.push(rnglines[0]);
			lines.push(rnglines[1]+offset);
		}else if (s == '$'){
			lines.push (rng.bounds('end').line()+offset);
		}else if (s == '%'){
			lines.push(0);
			lines.push (rng.bounds('end').line()+offset);
		}else if (s == ';'){
			if (lines.length > 0)	currLine = lines[lines.length-1];
		}else if (s == ''){
			lines.push(offset);
		}
	});
	rng.bounds('line', lines.pop(), lines.pop());
}

// we want to be able to list RegExp's with set, which uses JSON.stringify. This function lets us to that.
function REtoJSON() { return '/' + this.source + '/' + (this.flags || '') }
function createRE(s, ignorecase){
	// create a RegExp from a string (with an aribitrary delimiter), of the form /re/(rest)?/?flags?/? (the "rest" part is for the substitute command)
	// as with splitCommands above, easier to scan with a simple parser than to use RegExps
	var delim = s.charAt(0);
	var escaper = /\\/;
	var re, rest,flags;
	for (var i = 1; i < s.length; ++i){
		var c = s.charAt(i);
		if (escaper.test(c)) ++i;
		if (c == delim) break;
	}
	re = s.substring(1, i);
	s = s.substring(i+1);
	// flags may end with a delimiter, put in by the parser in splitCommands
	s = s.replace(RegExp('(['+REflags+']*)\\'+delim+'?$'), function(match, p1){
		flags = p1;
		return '';
	});
	if (re == ''){
		// blank string means use last regular expression
		re = lastRE.source;
		flags = flags || lastRE.flags;
	}
	if (!/M/i.test(flags)) flags += 'm'; // default is multiline mode unless we mark it otherwise with M
	if (ignorecase && !/I/i.test(flags)) flags += 'i'; // allow for global option to ignore case
	var ret = new RegExp(re, flags.replace(/[^igm]/g,''));  // don't forget to remove the invalid flags
	if (/w/.test(flags)) ret.nowrap = false;
	if (/W/.test(flags)) ret.nowrap = true;
	ret.rest = s.replace(new RegExp('\\'+delim+'$'), ''); // remove the last delimiter if present
	lastRE = ret;
	lastRE.flags = flags;
	lastRE.toJSON = REtoJSON;
	return ret;
}
bililiteRange.ex.createRE = createRE;

function interpretOffset(s){
	var re = /([-+]\d*)|\d+/g, ret = 0, match;
	while(match = re.exec(s)){
		switch (match[0]){
			case '+' : ++ret; break;
			case '-' : --ret; break;
			default: ret += parseInt(match[0]);
		}
	}
	return ret;
}

/*********************** the registers *********************************/

function pushRegister(text, register){
	if (register){
		if (/^[A-Z]/.test(register)){
			// uppercase means append
			registers[register.toLowerCase()] += text;
		}else{
			registers[register] = text;
		}
	}else{
		// unnamed register is the delete stack
		registers.unshift(text);
	}		
}

function popRegister (register){
	return register ? registers[register.toLowerCase()] : registers.shift();
}

/*********************** the actual editing commands *********************************/

// a command is a function (parameter {String}, variant {Boolean})
// 'this' is the bililiteRange; or a string that marks a synonym
var commands = bililiteRange.ex.commands = {
	a: 'append',

	ai: 'autoindent',

	append: function (parameter, variant){
		this.bounds('EOL').text(parameter, {
			select: 'end',
			ownline: true,
			autoindent: variant ? 'invert' : undefined
		});
	},

	c: 'change',

	change: function (parameter, variant){
		pushRegister (this.text());
		const indentation = this.indentation();
		this.text(parameter, {
			select: 'end',
			inputType: 'insertReplacementText'
		});
		// the test is variant XOR autoindent. the !'s turn booleany values to boolean, then != means XOR
		if (!variant != !this.data.autoindent) this.indent(indentation);
	},

	copy: function (parameter, variant){
		var targetrng = this.clone();
		var parsed = parseCommand(parameter, '.');
		interpretAddresses(targetrng, parsed.addresses);
		targetrng.bounds('endbounds').text(parameter, {
			select: 'end',
			ownline: true,
			inputType: 'insertFromPaste'
		});
		this.bounds(targetrng.bounds());
	},

	del: function (parameter, variant){
		var match = /^([a-zA-Z]?)\s*(\d*)/.exec(parameter);
		// the regular expression will match anything (all the components are optional), so match is never false
		if (match[2]){
			// a count means we to change the range in e.g., 1,2 d 3 from [1,2] to [2,2+3-1] (3 lines from the end of the range, inclusive)
			var lines = this.lines();
			this.bounds('line', lines[1], lines[1]+Math.max(1, parseInt(match[2]))-1);
		}
		pushRegister(this.text(), match[1]);
		this.bounds('andnewline').text('', {select: 'end', inputType: 'deleteContent'});
	},

	'delete': 'del',
	
	dir: 'directory',
	
	edit: function (parameter, variant){
		const file = parameter || this.data.file;
		this.data.reader(file, this.data.directory).then( text => {
			if (parameter) this.data.file = parameter;
			this.all(text).bounds('end');
			this.data.savestatus = 'clean';
			this.data.stdout (file + ' loaded');
		}).catch(
			err => this.data.stderr (new Error (file + ' not loaded'))
		);
	},

	global: function (parameter, variant){
		var re = createRE(parameter, this.data.ignorecase);
		var commands = splitCommands(string(re.rest), '\\n');
		var line = this.clone();
		var lines = this.lines();
		for (var i = lines[0]; i <= lines[1]; ++i){
			if (re.test(line.bounds('line', i).text()) != variant){
				var oldlines = this.all().split('\n').length;
				commands.forEach(function(command){
					var parsed = parseCommand(command);
					parsed.command.call(line, parsed.parameter, parsed.variant);
				});
				var addedlines = this.all().split('\n').length - oldlines;
				lines[1] += addedlines;
				if (addedlines > 0) i += addedlines;
				// note that this assumes the added lines are all  before or immediately after the current line. If not, we will skip the wrong lines			
			}
		}
		this.bounds(line.bounds()).bounds('endbounds'); // move to the end of the last modified line
	},

	hardtabs: 'tabsize',

	ht: 'tabsize',

	i: 'insert',

	insert: function (parameter, variant){
		// go to right before the beginning of this line
		this.bounds('BOL').bounds(this[0]-1).text(parameter, {
			select: 'end',
			ownline: true,
			autoindent: variant ? 'invert' : undefined
		});
	},

	ic: 'ignorecase',

	join: function (parameter, variant){
		var lines = this.lines();
		var match = /^\d+/.exec(parameter);
		if (match){
			// a count means we to change the range in e.g., 1,2 d 3 from [1,2] to [2,2+3-1] (3 lines from the end of the range, inclusive)
			lines = [lines[1], lines[1]+parseInt(match[0])-1];
		}
		if (lines[0] == lines[1]) ++lines[1]; // join at least 2 lines
		var re = variant ? /\n/g : /\s*\n\s*/g;
		var replacement = variant ? '' : ' '; // just one space. Doesn't do what the ex manual says about not inserting a space before a ')'
		this.bounds('line', lines[0], lines[1]);
		this.text(this.text().replace(re, replacement), {
			select: 'start',
			inputType: 'insertReplacementText'
		});
	},

	k: 'mark',

	m: 'move',
	
	map: function (parameter, variant){
		
	},

	mark: function (parameter, variant){
		const mark = this.clone();
		this.data.marks[parameter] = mark.live();
	},

	move: function (parameter, variant){
		const text = this.text();
		const parsed = parseCommand(parameter, '.');
		const targetrng = this.clone();
		interpretAddresses(targetrng, parsed.addresses);
		if (targetrng[0] >= this[0] && targetrng[0] <= this[1]) return; // if target is inside the current range, don't do anything
		targetrng.bounds('endbounds');
		this.bounds('andnewline').text('', {inputType: 'deleteByDrag'});
		targetrng.text(text, {
			select: 'start',
			ownline: true,
			inputType: 'insertFromDrop'
		});
		if (targetrng[0] >= this[0]) targetrng[0] -= text.length; // account for the removed text
		this.bounds(targetrng[0]);
	},

	notglobal: function (parameter, variant){
		commands.global.call (this, parameter, !variant);
	},

	print: function() { this.select() },

	put: function (parameter, variant){
		this.bounds('EOL').text(popRegister(parameter), {
			inputType: 'insertFromYank',
			select: 'end',
			ownline: true
		});
	},
	
	read: function (parameter, variant){
		const file = parameter || this.data.file;
		this.data.reader(file, this.data.directory).then( text => {
			this.bounds('EOL').text(text, {
				select: 'end',
				ownline: true
			});
			this.data.stdout(file + ' read');
		}).catch(
			err => this.data.stderr(new Error (file + ' not read'))
		);
	},

	redo: function (parameter, variant){
		// restores the text only, not any other aspects of state
		this.undo(-1);
	},

	s: 'substitute',

	set: function (parameter, variant){
		if (!parameter){
			this.data.stdout (JSON.stringify(this.data));
		}else if(parameter == 'all'){
			this.data.stdout (JSON.stringify (this.data.all));
		}else{
			var self = this;
			splitCommands(parameter, ' ').forEach(function(command){
				var match = /(no)?([^=?]+)(\?|=(.+)|)/.exec(command);
				if (!match && command.trim()) throw new Error('Bad syntax in set: '+command);
				var func = match[2];
				if (match[1]){
					var value = 'off';
				}else if (!match[3]){
					value = 'on';
				}else if (match[3] == '?'){
					value = '?';
				}else{
					value = string(match[4]);
				}
				commandCompletion(func).call(self, value, variant); // each option takes care of its own setting
			});
		}
	},

	shiftwidth: "tabsize",
	
	source: function (parameter, variant){
		if (!parameter) throw new Error ('No file named in source');
		this.data.reader(parameter, this.data.directory).then( sourcefile => {
			sourcefile.split('\n').forEach ( line => this.ex(line) );
		}).catch(
			err => this.data.stderr(new Error (file + ' not read in source'))
		);
	},

	substitute: function (parameter, variant){
		// we do not use the count parameter (too hard to interpret s/(f)oo/$1 -- is that last 1 a count or part of the replacement?
		// easy enough to assume it's part of the replacement but that's probably not what we meant)
		var re = createRE(parameter, this.data.ignorecase);
		this.text(this.text().replace(re, string(re.rest))).bounds('endbounds');
	},

	sw: 'tabsize',

	t: 'copy',
	
	tabstop: 'tabsize',

	transcribe: 'copy',

	ts: 'tabsize',
	
	write: function (parameter, variant){
		// unlike real ex, always writes the whole file.
		const file = parameter || this.data.file;
		this.data.writer (this.all(), file, this.data.directory).then( () => {
			this.data.savestatus = 'clean';
			if (parameter) this.data.file = parameter;
			this.data.stdout (file + ' saved');
		}).catch(
			err => this.data.stderr(new Error (file + ' not saved'))
		);
	},

	u: 'undo',

	undo: function (parameter, variant){
		// restores the text only, not any other aspects of state
		this.undo();
	},

	v: 'notglobal',

	ws: 'wrapscan',

	yank: function (parameter, variant){
		var match = /^([a-zA-Z]?)\s*(\d*)/.exec(parameter);
		// the regular expression will match anything (all the components are optional), so match is never false
		if (match[2]){
			// a count means we to change the range in e.g., 1,2 y 3 from [1,2] to [2,2+3-1] (3 lines from the end of the range, inclusive)
			var lines = this.lines();
			this.bounds('line', lines[1], lines[1]+Math.max(1, parseInt(match[2]))-1);
		}
		pushRegister(this.text(), match[1]);
	},

	'=': function (){
		let lines = this.lines();
		this.data.stdout ('['+(lines[0] == lines[1] ? lines[0] : lines[0]+', '+lines[1])+']');
	},
	
	'&': 'substitute',

	'~': function (parameter, variant){
		lastRE = new RegExp (lastRE.rest, 'g');
		commands.substitute.call (this, parameter, variant);
	},
	
	'>': function (parameter, variant){
		parameter = parseInt(parameter);
		if (isNaN(parameter) || parameter < 0) parameter = 1;
		this.indent('\t'.repeat(parameter));
	},
	
	'<': function (parameter, variant){
		parameter = parseInt(parameter);
		if (isNaN(parameter) || parameter < 0) parameter = 1;
		this.unindent(parameter, this.data.tabsize);
	},
	
	'!': function (parameter, variant){
		// not a shell escape but a Javascript escape
		this.text(Function (parameter).call(this), {select: 'end'});
	}
};

/*********************** the options *********************************/

function createOption (name, value){
	bililiteRange.createOption(name, {value: value});
	// now create a command to set the value, based on value's type
	var constructor = value.constructor.name;
	bililiteRange.ex.commands[name] = (createOption[constructor] || createOption.generic)(name);
}

bililiteRange.ex.createOption = createOption;

createOption.generic = function (name){
	return function (parameter, variant){
		if (parameter == '?' || parameter === true || !parameter){
			this.data.stdout (JSON.stringify(this.data[name]));
		}else{
			this.data[name] = parameter;
		}
	}
}

createOption.Boolean = function (name){
	return function (parameter, variant){
		const data = this.data;
		if (parameter=='?'){
			data.stdout (data[name] ? 'on' : 'off');
		}else if (parameter == 'off' || parameter == 'no' || parameter == 'false'){
			data[name] = variant;
		}else if (parameter == 'toggle'){
			data[name] = !data[name];
		}else{
			data[name] = !variant; // variant == false means take it straight and set the option
		}
	};
}

createOption.Number = function (name){
	return function (parameter, variant){
		if (parameter == '?' || parameter === true || !parameter){
			this.data.stdout ('['+this.data[name]+']');
		}else{
			var value = parseInt(parameter);
			if (isNaN(value)) throw new Error('Invalid value for '+name+': '+parameter);
			this.data[name] = value;
		}
	}
}

createOption.RegExp = function (name){
	return function (parameter, variant){
		if (parameter == '?' || parameter === true || !parameter){
			this.data.stdout (JSON.stringify(this.data[name]));
		}else{
			this.data[name] = createRE(parameter, this.data.ignorecase);
		}
	}
}

createOption ('autoindent', false);
createOption ('ignorecase', false);
createOption ('tabsize', 8);
createOption ('wrapscan', true);
createOption ('directory', '');
createOption ('file', 'document');

})();