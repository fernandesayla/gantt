/**
 * Gantt:
 * 	element: querySelector string, required
 * 	tasks: array of tasks, required
 *   task: { id, name, start, end, progress, dependencies, custom_class }
 * 	config: configuration options, optional
 */
import './gantt.scss';

import Bar from './Bar';
import Arrow from './Arrow';
import moment from 'moment';
import Snap from 'imports-loader?this=>window,fix=>module.exports=0!snapsvg/dist/snap.svg.js';

export default function Gantt(element, projects, config) {

	const self = {};

	function init() {
		set_defaults();

		// expose methods
		self.change_view_mode = change_view_mode;
		self.unselect_all = unselect_all;
		self.view_is = view_is;
		self.get_bar = get_bar;
		self.trigger_event = trigger_event;
		self.refresh = refresh;

		// initialize with default view mode
		change_view_mode(self.config.view_mode);
	}

	function set_defaults() {

		const defaults = {
			header_height: 50,
			column_width: 30,
			step: 24,
			view_modes: [
				'Quarter Day',
				'Half Day',
				'Day',
				'Week',
				'Month'
			],
			bar: {
				height: 20
			},
			arrow: {
				curve: 5
			},
			padding: 18,
			view_mode: 'Month',
			date_format: 'YYYY-MM-DD',
			custom_popup_html: null,
			left_width: 0,
			inline: true,
			projection: false
		};
		self.config = Object.assign({}, defaults, config);

		reset_variables();
	}

	function reset_variables() {
		self.element = element;
		self._tasks = [];
		projects.forEach(project =>
			self._tasks = self._tasks.concat(project.tasks));
		self._projects = projects;
		self._projects._rows = self._tasks.length;
		self._bars = [];
		self._arrows = [];
		self.element_groups = {};
	}

	function refresh(updated_tasks) {
		reset_variables(updated_tasks);
		change_view_mode(self.config.view_mode);
	}

	function change_view_mode(mode) {
		prepare();
		set_scale(mode);
		render();
		// fire viewmode_change event
		trigger_event('view_change', [mode]);
	}

	function prepare() {
		prepare_tasks();
		prepare_projects();
		prepare_dependencies();
		prepare_dates();
		prepare_canvas();
	}

	function prepare_tasks() {

		// prepare tasks
		self.tasks = self._tasks.map((task, i) => {

			// momentify
			task._start = moment(task.start, self.config.date_format);
			task._end = moment(task.end, self.config.date_format);

			// cache index
			task._index = i;

			// invalid dates
			if(!task.start && !task.end) {
				task._start = moment().startOf('day');
				task._end = moment().startOf('day').add(2, 'days');
			}
			if(!task.start && task.end) {
				task._start = task._end.clone().add(-2, 'days');
			}
			if(task.start && !task.end) {
				task._end = task._start.clone().add(2, 'days');
			}

			// invalid flag
			if(!task.start || !task.end) {
				task.invalid = true;
			}

			// dependencies
			if(typeof task.dependencies === 'string' || !task.dependencies) {
				let deps = [];
				if(task.dependencies) {
					deps = task.dependencies
						.split(',')
						.map(d => d.trim())
						.filter((d) => d);
				}
				task.dependencies = deps;
			}

			// uids
			if(!task.id) {
				task.id = generate_id(task);
			}

			// inline
			if(self.config.inline) {
				const previousTask = self._tasks[i - 1];
				const newProject = (previousTask && task.projectId !== previousTask.projectId);

				if (!previousTask) {
					task._line = 0;
				}else if(previousTask._end < task._start && !newProject) {
					task._line = previousTask._line;
				}else {
					task._line = previousTask._line + 1;
				}
			}else {
				task._line = task._index;
			}

			return task;
		});
	}

	function prepare_projects() {

		let rows = 0;

		self._projects.forEach((project, i) => {

			const tasks = project.tasks;

			tasks.forEach((task, i) => {
				const nextTask = tasks[i + 1];
				if(i === 0) project._firstRow = task._line;
				if(!nextTask) {
					project._lastRow = task._line;
					project._lastDate = get_max_date(project.tasks);
				}
				if(task.currentTask && self.config.projection) project._currentDate = get_date_progress(task);
			});

			project._late = moment().diff(project._currentDate, 'days');

			if(project._late > 0) {

				const start = moment(project._lastDate, self.config.date_format).clone().add(1, 'days');
				const end = moment(project._lastDate, self.config.date_format).clone().add(project._late, 'days');

				const task = {
					projectId: project.id,
					id: self.tasks.length + 1,
					name: 'Projeção de Término',
					_start: start,
					_end: end,
					_line: project._lastRow,
					custom_class: 'bar-late',
					dependencies: [],
					responsaveis: [],
					uors: [],
					periodos: [
						{
							dataInicio: start,
							dataFim: end,

							tipo: {
								nome: 'Previsão'
							}
						}
					]
				};
				self.tasks.push(task);
			}

			project._rows = project._lastRow - project._firstRow + 1;
			rows += project._rows;
		});
		self._projects._rows = rows;
	}

	function prepare_dependencies() {

		self.dependency_map = {};
		for(let t of self.tasks) {
			for(let d of t.dependencies) {
				self.dependency_map[d] = self.dependency_map[d] || [];
				self.dependency_map[d].push(t.id);
			}
		}
	}

	function prepare_dates() {

		self.gantt_start = self.gantt_end = null;
		for(let task of self.tasks) {
			// set global start and end date
			if(!self.gantt_start || task._start < self.gantt_start) {
				self.gantt_start = task._start;
			}
			if(!self.gantt_end || task._end > self.gantt_end) {
				self.gantt_end = task._end;
			}
		}
		set_gantt_dates();
		setup_dates();
	}

	function prepare_canvas() {
		if(self.canvas) return;
		self.canvas = Snap(self.element).addClass('gantt');
	}

	function render() {
		clear();
		setup_groups();
		make_grid();
		make_dates();
		make_bars();
		make_arrows();
		make_projects();
		map_arrows_on_bars();
		set_width();
		set_scroll_position();
		bind_grid_click();
	}

	function clear() {
		self.canvas.clear();
		self._bars = [];
		self._arrows = [];
	}

	function set_gantt_dates() {

		if(view_is(['Quarter Day', 'Half Day'])) {
			self.gantt_start = self.gantt_start.clone().subtract(7, 'day');
			self.gantt_end = self.gantt_end.clone().add(7, 'day');
		} else if(view_is('Month')) {
			self.gantt_start = self.gantt_start.clone().startOf('month').subtract(1, 'Month');
			// self.gantt_end = self.gantt_end.clone().endOf('month').add(1, 'year');
			self.gantt_end = self.gantt_end.clone().endOf('month');
		} else {
			self.gantt_start = self.gantt_start.clone().subtract(3, 'days');// .startOf('month');
			self.gantt_end = self.gantt_end.clone().add(3, 'days'); // .endOf('month');
		}
	}

	function setup_dates() {

		self.dates = [];
		let cur_date = null;

		while(cur_date === null || cur_date < self.gantt_end) {
			if(!cur_date) {
				cur_date = self.gantt_start.clone();
			} else {
				cur_date = view_is('Month') ?
					cur_date.clone().add(1, 'month') :
					cur_date.clone().add(self.config.step, 'hours');
			}
			self.dates.push(cur_date);
		}
	}

	function setup_groups() {

		const groups = ['grid', 'project', 'date', 'arrow', 'progress', 'bar', 'details'];
		// make group layers
		for(let group of groups) {
			self.element_groups[group] = self.canvas.group().attr({'id': group});
		}
	}

	function set_scale(scale) {
		self.config.view_mode = scale;
		const screen_width = 1832 - self.config.left_width;
		let min_width = 0;
		self.config.column_width = screen_width / self.dates.length;

		if(scale === 'Day') {
			min_width = 18;
			self.config.step = 24;
		} else if(scale === 'Half Day') {
			min_width = 38;
			self.config.step = 24 / 2;
		} else if(scale === 'Quarter Day') {
			min_width = 38;
			self.config.step = 24 / 4;
		} else if(scale === 'Week') {
			min_width = 140;
			self.config.step = 24 * 7;
		} else if(scale === 'Month') {
			min_width = 20;
			self.config.step = 24 * 30;
		}
		self.config.column_width = self.config.column_width < min_width ? min_width : self.config.column_width;
	}

	function set_width() {
		const cur_width = self.canvas.node.getBoundingClientRect().width;
		const actual_width = parseFloat(self.canvas.select('#grid .grid-row')
							.attr('width')) + self.config.left_width;

		if(cur_width < actual_width) {
			self.canvas.attr('width', actual_width);
		}
	}

	function set_scroll_position() {
		const parent_element = document.querySelector(self.element).parentElement;
		if(!parent_element) return;

		const scroll_pos = get_min_date().diff(self.gantt_start, 'hours') /
			self.config.step * self.config.column_width - self.config.column_width;
		parent_element.scrollLeft = scroll_pos;
	}

	function get_min_date() {
		const task = self.tasks.reduce((acc, curr) => {
			return curr._start.isSameOrBefore(acc._start) ? curr : acc;
		});
		return task._start;
	}

	function get_max_date(tasks) {
		const task = tasks.reduce((acc, curr) => {
			return curr._end.isSameOrAfter(acc._end) ? curr : acc;
		});
		return task.end;
	}

	function make_grid() {
		make_grid_background();
		make_grid_header();
		make_grid_rows();
		make_grid_ticks();
		make_grid_highlights();
	}

	function make_grid_background() {

		const grid_width = (self.dates.length * self.config.column_width) + self.config.left_width,
			grid_height = self.config.header_height + self.config.padding +
				(self.config.bar.height + self.config.padding) * self._projects._rows + 400;

		self.canvas.rect(0, 0, grid_width, grid_height)
			.addClass('grid-background')
			.appendTo(self.element_groups.grid);

		self.canvas.attr({
			height: grid_height + self.config.padding,
			width: '110%'
		});
	}

	function make_grid_header() {
		const header_width = self.dates.length * self.config.column_width,
			header_height = self.config.header_height + 10;
		self.canvas.rect(self.config.left_width, 0, header_width, header_height)
			.addClass('grid-header')
			.appendTo(self.element_groups.grid);
	}

	function make_grid_rows() {

		const rows = self.canvas.group().appendTo(self.element_groups.grid),
			lines = self.canvas.group().appendTo(self.element_groups.grid),
			row_width = self.dates.length * self.config.column_width,
			row_height = self.config.bar.height + self.config.padding,
			left_width = self.config.left_width;

		let row_y = self.config.header_height + self.config.padding / 2;

		self.tasks.forEach((task, index) => { // eslint-disable-line

			const nextTask = self.tasks[index + 1];
			if(task._index && (!nextTask || task._line !== nextTask._line)) {

				self.canvas.rect(left_width, row_y, row_width, row_height)
				.addClass('grid-row')
				.appendTo(rows);

				self.canvas.line(left_width, row_y + row_height, row_width + left_width, row_y + row_height)
				.addClass('row-line')
				.appendTo(lines);

				row_y += self.config.bar.height + self.config.padding;
			}
		});
	}

	function make_projects() {

		const rows = self.canvas.group().appendTo(self.element_groups.project),
			lines = self.canvas.group().appendTo(self.element_groups.project),
			text = self.canvas.group().appendTo(self.element_groups.project),
			current = self.canvas.group().appendTo(self.element_groups.project),
			row_width = self.dates.length * self.config.column_width,
			row_height = self.config.bar.height + self.config.padding,
			left_width = self.config.left_width;

		const header_height = self.config.header_height + self.config.padding / 2;
		let row_y = header_height;

		self._projects.forEach((project) => { // eslint-disable-line

			const height = row_height * project._rows,
				late = project._late > 0 ? '-late' : '';
			row_y = header_height + (row_height * project._firstRow);

			if(self.config.left_width > 0)	{
				self.canvas.rect(0, row_y, left_width, height)
					.addClass('grid-project-row')
					.appendTo(rows);

				self.canvas.line(0, row_y + height, row_width + left_width, row_y + height)
					.addClass('row-line-project')
					.appendTo(lines);

				self.canvas.text(self.config.left_width / 2, row_y + (height / 2), project.name)
					.addClass('project-text')
					.appendTo(text);
			}

			if(view_is('Month') && project._currentDate) {
				const x = (project._currentDate.startOf('day').diff(self.gantt_start, 'days') *
							self.config.column_width / 30) + self.config.left_width;

				self.canvas.path(Snap.format('M {x} {y} v {height}', {
					x: x,
					y: row_y,
					height: height
				}))
				.addClass('tick-current' + late)
				.appendTo(current);
			} else if(view_is('Day') && project._currentDate) {
				const x = (project._currentDate.clone().startOf('day').diff(self.gantt_start, 'hours') /
						self.config.step * self.config.column_width) + self.config.left_width;
				const width = self.config.column_width;

				self.canvas.rect(x, row_y, width, height)
				.addClass('current-highlight' + late)
				.appendTo(current);
			}

		});
	}

	function make_grid_ticks() {
		let tick_x = self.config.left_width,
			tick_height = (self.config.bar.height + self.config.padding) * self._projects._rows;

		for(let date of self.dates) {

			let tick_y = self.config.header_height + self.config.padding / 2;

			let tick_class = 'tick';
			// thick tick for monday
			if(view_is('Day') && date.day() === 1) {
				tick_class += ' thick';
			}
			// thick tick for first week
			if(view_is('Week') && date.date() >= 1 && date.date() < 8) {
				tick_class += ' thick';
			}
			// thick ticks for quarters
			if(view_is('Month') && date.month() === 0) {
				tick_class += ' thick';
				tick_y = tick_y / 2;
			}

			self.canvas.path(Snap.format('M {x} {y} v {height}', {
				x: tick_x,
				y: tick_y,
				height: tick_height
			}))
			.addClass(tick_class)
			.appendTo(self.element_groups.grid);

			if(view_is('Month')) {
				tick_x += date.daysInMonth() * self.config.column_width / 30;
			} else {
				tick_x += self.config.column_width;
			}
		}
	}

	function make_grid_highlights() {
		// highlight today's date

		const y = 0;
		const header_height = self.config.header_height + self.config.padding / 2;
		const height = (self.config.bar.height + self.config.padding) * self._projects._rows +
				header_height;

		if(view_is('Day')) {
			const x = (moment().startOf('day').diff(self.gantt_start, 'hours') /
						self.config.step * self.config.column_width) + self.config.left_width;
			const width = self.config.column_width;

			if (x <= self.element_groups.grid.getBBox().width && x >= self.config.left_width) {
				self.canvas.rect(x, y, width, height)
					.addClass('today-highlight')
					.appendTo(self.element_groups.grid);
			}

		}else {

			const x = (moment().startOf('day').diff(self.gantt_start, 'days') *
					self.config.column_width / 30) + self.config.left_width;

			if (x <= self.element_groups.grid.getBBox().width && x >= self.config.left_width) {
				self.canvas.path(Snap.format('M {x} {y} v {height}', {
					x: x,
					y: header_height,
					height: height - header_height
				}))
				.addClass('tick-today')
				.appendTo(self.element_groups.grid);
			}
		}
	}

	function make_dates() {
		for(let date of get_dates_to_draw()) {

			let grid_width = self.element_groups.grid.getBBox().width;
			date.lower_x += self.config.left_width;
			date.upper_x += self.config.left_width;

			self.canvas.text(date.lower_x, date.lower_y, date.lower_text)
				.addClass('lower-text')
				.appendTo(self.element_groups.date);

			if(date.upper_text) {

				const $upper_text = self.canvas.text(date.upper_x, date.upper_y, date.upper_text)
					.addClass('upper-text')
					.appendTo(self.element_groups.date);

				date.lower_x += ((grid_width) - (date.lower_x)) / 2;

				if($upper_text.getBBox().x2 > grid_width) {
					self.canvas.text(date.lower_x, date.upper_y, date.upper_text)
					.addClass('upper-text')
					.appendTo(self.element_groups.date);

					$upper_text.remove();
				}
			}
		}
	}

	function get_dates_to_draw() {
		let lower_x = 0,
			last_date = null;

		const dates = self.dates.map((date, i) => {

			const d = get_date_info(date, last_date, i);
			last_date = date;
			d.lower_x = lower_x + self.config.column_width / 2;
			lower_x += date.daysInMonth() * self.config.column_width / 30;
			return d;
		});
		return dates;
	}

	function get_date_info(date, last_date, i) {
		if(!last_date) {
			last_date = date.clone().add(1, 'year').add(1, 'month').add(1, 'day');
		}
		const min_width_month = 60;

		const date_text = {
			'Quarter Day_lower': date.format('HH'),
			'Half Day_lower': date.format('HH'),
			'Day_lower': date.date() !== last_date.date() ? date.format('D') : '',
			'Week_lower': date.month() !== last_date.month() ?
				date.format('D MMM') : date.format('D'),
			'Month_lower': date.format(self.config.column_width < min_width_month ? 'MM' : 'MMMM'),
			'Quarter Day_upper': date.date() !== last_date.date() ? date.format('D MMM') : '',
			'Half Day_upper': date.date() !== last_date.date() ?
				date.month() !== last_date.month() ?
				date.format('D MMM') : date.format('D') : '',
			'Day_upper': date.month() !== last_date.month() ? date.format('MMMM') : '',
			'Week_upper': date.month() !== last_date.month() ? date.format('MMMM') : '',
			'Month_upper': date.year() !== last_date.year() ? date.format('YYYY') : ''
		};

		const base_pos = {
			x: i * self.config.column_width,
			lower_y: self.config.header_height,
			upper_y: self.config.header_height - 25
		};

		const x_pos = {
			'Quarter Day_lower': (self.config.column_width * 4) / 2,
			'Quarter Day_upper': 0,
			'Half Day_lower': (self.config.column_width * 2) / 2,
			'Half Day_upper': 0,
			'Day_lower': self.config.column_width / 2,
			'Day_upper': (self.config.column_width * 30) / 2,
			'Week_lower': 0,
			'Week_upper': (self.config.column_width * 4) / 2,
			// 'Month_lower': self.config.column_width / 2,
			'Month_upper': (self.config.column_width * (12 - date.month())) / 2

		};

		return {
			upper_text: date_text[`${self.config.view_mode}_upper`],
			lower_text: date_text[`${self.config.view_mode}_lower`],
			upper_x: base_pos.x + x_pos[`${self.config.view_mode}_upper`],
			upper_y: base_pos.upper_y,
			// lower_x: base_pos.x + x_pos[`${self.config.view_mode}_lower`],
			lower_y: base_pos.lower_y
		};
	}

	function get_date_progress(task) {
		const duration = (task._end.diff(task._start, 'hours') + 24) / self.config.step;
		return task._start.clone().add((duration * task.progress) / 100, 'days');
	}

	function make_arrows() {
		self._arrows = [];
		for(let task of self.tasks) {
			let arrows = [];
			arrows = task.dependencies.map(dep => {
				const dependency = get_task(dep);
				if(!dependency) return;
				const arrow = Arrow(
					self, // gt
					self._bars[dependency._index], // from_task
					self._bars[task._index] // to_task
				);
				self.element_groups.arrow.add(arrow.element);
				return arrow; // eslint-disable-line
			}).filter(arr => arr); // filter falsy values
			self._arrows = self._arrows.concat(arrows);
		}
	}

	function make_bars() {
		self._bars = self.tasks.map((task, i) => {

			const bar = Bar(self, task);
			self.element_groups.bar.add(bar.group);
			return bar;
		});
	}

	function map_arrows_on_bars() {
		for(let bar of self._bars) {
			bar.arrows = self._arrows.filter(arrow => {
				return (arrow.from_task.task.id === bar.task.id) ||
					(arrow.to_task.task.id === bar.task.id);
			});
		}
	}

	function bind_grid_click() {
		self.element_groups.grid.click(() => {
			unselect_all();
			self.element_groups.details
				.selectAll('.details-wrapper')
				.forEach(el => el.addClass('hide'));
		});
	}

	function unselect_all() {
		self.canvas.selectAll('.bar-wrapper').forEach(el => {
			el.removeClass('active');
		});
	}

	function view_is(modes) {
		if (typeof modes === 'string') {
			return self.config.view_mode === modes;
		} else if(Array.isArray(modes)) {
			for (let mode of modes) {
				if(self.config.view_mode === mode) return true;
			}
			return false;
		}
	}

	function get_task(id) {
		return self.tasks.find((task) => {
			return task.id === id;
		});
	}

	function get_bar(id) {
		return self._bars.find((bar) => {
			return bar.task.id === id;
		});
	}

	// function get_project(id) {
	// 	return self._projects.find(project => project.id === id);
	// }

	function generate_id(task) {
		return task.name + '_' + Math.random().toString(36).slice(2, 12);
	}

	function trigger_event(event, args) {
		if(self.config['on_' + event]) {
			self.config['on_' + event].apply(null, args);
		}
	}

	init();

	return self;
}
