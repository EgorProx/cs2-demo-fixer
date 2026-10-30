using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

namespace Cs2DemoFixer
{
    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            if (args.Length >= 3 && args[0] == "--fix")
            {
                string cli = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "cli.js");
                string log = args.Length >= 4 ? args[3] :
                    Path.Combine(Path.GetDirectoryName(args[2]), "cs2-demo-fixer.log");
                try
                {
                    string stdout, stderr;
                    int code = Backend.RunNode(cli, args[1], args[2], out stdout, out stderr);
                    string text = stdout;
                    if (!string.IsNullOrEmpty(stderr)) text += Environment.NewLine + stderr;
                    File.WriteAllText(log, text, new UTF8Encoding(false));
                    Environment.ExitCode = code;
                }
                catch (Exception ex)
                {
                    try { File.WriteAllText(log, ex.ToString(), new UTF8Encoding(false)); }
                    catch { }
                    Environment.ExitCode = 1;
                }
                return;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm());
        }
    }

    internal static class Backend
    {
        public static int RunNode(string cliPath, string input, string output, out string stdout, out string stderr)
        {
            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = FindNode();
            psi.Arguments = Quote(cliPath) + " " + Quote(input) + " " + Quote(output);
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;
            psi.WorkingDirectory = Path.GetDirectoryName(cliPath);

            StringBuilder outBuf = new StringBuilder();
            StringBuilder errBuf = new StringBuilder();
            int code;
            using (Process p = new Process())
            {
                p.StartInfo = psi;
                p.OutputDataReceived += delegate(object s, DataReceivedEventArgs e)
                {
                    if (e.Data != null) outBuf.AppendLine(e.Data);
                };
                p.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e)
                {
                    if (e.Data != null) errBuf.AppendLine(e.Data);
                };
                p.Start();
                p.BeginOutputReadLine();
                p.BeginErrorReadLine();
                p.WaitForExit();
                code = p.ExitCode;
            }
            stdout = outBuf.ToString().TrimEnd();
            stderr = errBuf.ToString().TrimEnd();
            return code;
        }

        public static string FindNode()
        {
            string env = Environment.GetEnvironmentVariable("CS2DEMOFIX_NODE");
            if (!string.IsNullOrEmpty(env) && File.Exists(env)) return env;
            List<string> candidates = new List<string>();
            string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            string pf86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            if (!string.IsNullOrEmpty(pf)) candidates.Add(Path.Combine(pf, "nodejs", "node.exe"));
            if (!string.IsNullOrEmpty(pf86)) candidates.Add(Path.Combine(pf86, "nodejs", "node.exe"));
            if (!string.IsNullOrEmpty(local)) candidates.Add(Path.Combine(local, "Programs", "nodejs", "node.exe"));
            foreach (string c in candidates)
            {
                if (File.Exists(c)) return c;
            }
            return "node";
        }

        private static string Quote(string s)
        {
            return "\"" + s + "\"";
        }
    }

    internal sealed class Job
    {
        public string Input;
        public string Output;
        public ListViewItem Item;
    }

    internal sealed class MainForm : Form
    {
        private static readonly Color Bg = Color.White;
        private static readonly Color PanelBg = Color.FromArgb(250, 250, 250);
        private static readonly Color TextColor = Color.FromArgb(31, 35, 40);
        private static readonly Color Muted = Color.FromArgb(110, 119, 129);
        private static readonly Color Accent = Color.FromArgb(31, 35, 40);
        private static readonly Color Line = Color.FromArgb(208, 215, 222);

        private readonly List<Job> _jobs = new List<Job>();
        private readonly ListView _list;
        private readonly DropPanel _drop;
        private readonly Button _addButton;
        private readonly Button _removeButton;
        private readonly Button _fixButton;
        private readonly Button _showButton;
        private readonly Button _copyButton;
        private readonly Label _status;
        private readonly TextBox _log;
        private readonly ProgressBar _progress;
        private readonly string _cliPath;
        private string _lastOutput;
        private bool _busy;

        public MainForm()
        {
            Text = "CS2 Demo Fixer";
            ClientSize = new Size(850, 640);
            MinimumSize = new Size(740, 560);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Bg;
            ForeColor = TextColor;
            Font = new Font("Segoe UI", 9.75f);
            AutoScaleMode = AutoScaleMode.Dpi;
            _cliPath = Path.Combine(Application.StartupPath, "cli.js");

            TableLayoutPanel root = new TableLayoutPanel();
            root.Dock = DockStyle.Fill;
            root.Padding = new Padding(16, 14, 16, 12);
            root.ColumnCount = 1;
            root.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));
            root.RowCount = 7;
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 60f));
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 112f));
            root.RowStyles.Add(new RowStyle(SizeType.Percent, 100f));
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 44f));
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 24f));
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 132f));
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 34f));
            root.BackColor = Bg;
            Controls.Add(root);

            Panel header = new Panel();
            header.Dock = DockStyle.Fill;
            header.BackColor = Bg;
            header.Margin = new Padding(0);
            Label title = new Label();
            title.Text = "CS2 Demo Fixer";
            title.Font = new Font("Segoe UI", 20f, FontStyle.Bold);
            title.ForeColor = TextColor;
            title.AutoSize = true;
            title.Location = new Point(0, 0);
            Label subtitle = new Label();
            subtitle.Text = "Починка демок FACEIT, которые вылетают сразу после playdemo";
            subtitle.ForeColor = Muted;
            subtitle.AutoSize = true;
            subtitle.Location = new Point(2, 35);
            header.Controls.Add(title);
            header.Controls.Add(subtitle);
            root.Controls.Add(header, 0, 0);

            _drop = new DropPanel();
            _drop.Dock = DockStyle.Fill;
            _drop.Margin = new Padding(0, 0, 0, 10);
            _drop.FilesDropped += OnFilesDropped;
            _drop.Click += delegate { PickFiles(); };
            root.Controls.Add(_drop, 0, 1);

            _list = new ListView();
            _list.Dock = DockStyle.Fill;
            _list.View = View.Details;
            _list.FullRowSelect = true;
            _list.MultiSelect = true;
            _list.HideSelection = false;
            _list.BorderStyle = BorderStyle.FixedSingle;
            _list.BackColor = PanelBg;
            _list.ForeColor = TextColor;
            _list.Margin = new Padding(0, 0, 0, 8);
            _list.Columns.Add("Файл", 390);
            _list.Columns.Add("Размер", 92, HorizontalAlignment.Right);
            _list.Columns.Add("Статус", 280);
            _list.SelectedIndexChanged += delegate { UpdateButtons(); };
            _list.DoubleClick += delegate { ShowInFolder(); };
            _list.AllowDrop = true;
            _list.DragEnter += OnDragEnter;
            _list.DragDrop += OnDragDrop;
            root.Controls.Add(_list, 0, 2);

            FlowLayoutPanel buttons = new FlowLayoutPanel();
            buttons.Dock = DockStyle.Fill;
            buttons.FlowDirection = FlowDirection.RightToLeft;
            buttons.WrapContents = false;
            buttons.BackColor = Bg;
            buttons.Margin = new Padding(0);

            _fixButton = MakeButton("Починить", true);
            _addButton = MakeButton("Добавить файлы", false);
            _removeButton = MakeButton("Убрать", false);
            _showButton = MakeButton("Показать в папке", false);
            _copyButton = MakeButton("Копировать playdemo", false);
            _fixButton.Click += delegate { StartFix(); };
            _addButton.Click += delegate { PickFiles(); };
            _removeButton.Click += delegate { RemoveSelected(); };
            _showButton.Click += delegate { ShowInFolder(); };
            _copyButton.Click += delegate { CopyPlaydemo(); };
            buttons.Controls.Add(_fixButton);
            buttons.Controls.Add(_copyButton);
            buttons.Controls.Add(_showButton);
            buttons.Controls.Add(_removeButton);
            buttons.Controls.Add(_addButton);
            root.Controls.Add(buttons, 0, 3);

            Panel statusPanel = new Panel();
            statusPanel.Dock = DockStyle.Fill;
            statusPanel.BackColor = Bg;
            statusPanel.Margin = new Padding(0);
            _status = new Label();
            _status.Dock = DockStyle.Fill;
            _status.Text = "Добавь демку, чтобы начать.";
            _status.TextAlign = ContentAlignment.MiddleLeft;
            _status.ForeColor = Muted;
            _status.Padding = new Padding(2, 0, 0, 0);
            _progress = new ProgressBar();
            _progress.Dock = DockStyle.Right;
            _progress.Width = 170;
            _progress.Style = ProgressBarStyle.Marquee;
            _progress.MarqueeAnimationSpeed = 30;
            _progress.Visible = false;
            statusPanel.Controls.Add(_status);
            statusPanel.Controls.Add(_progress);
            root.Controls.Add(statusPanel, 0, 4);

            _log = new TextBox();
            _log.Dock = DockStyle.Fill;
            _log.Multiline = true;
            _log.ReadOnly = true;
            _log.ScrollBars = ScrollBars.Vertical;
            _log.BackColor = Color.White;
            _log.ForeColor = Color.FromArgb(55, 65, 75);
            _log.BorderStyle = BorderStyle.FixedSingle;
            _log.Font = new Font("Consolas", 9f);
            _log.Margin = new Padding(0, 0, 0, 8);
            root.Controls.Add(_log, 0, 5);

            Label hint = new Label();
            hint.Dock = DockStyle.Fill;
            hint.Text = "Готовый файл: steamapps\\common\\Counter-Strike Global Offensive\\game\\csgo, затем в консоли: playdemo имя-файла";
            hint.ForeColor = Muted;
            hint.TextAlign = ContentAlignment.MiddleLeft;
            hint.AutoSize = false;
            hint.Margin = new Padding(0);
            root.Controls.Add(hint, 0, 6);

            AllowDrop = true;
            DragEnter += OnDragEnter;
            DragDrop += OnDragDrop;

            _log.Text = "Готов к работе. Перетащи .dem, .dem.zst или .dem.gz." + Environment.NewLine;
            UpdateButtons();
        }

        private static Button MakeButton(string text, bool primary)
        {
            Button b = new Button();
            b.Text = text;
            b.AutoSize = true;
            b.FlatStyle = FlatStyle.Flat;
            b.FlatAppearance.BorderSize = primary ? 0 : 1;
            b.FlatAppearance.BorderColor = Line;
            b.BackColor = primary ? Accent : Color.White;
            b.ForeColor = primary ? Color.White : TextColor;
            b.FlatAppearance.MouseOverBackColor = primary ? Color.FromArgb(55, 65, 75) : Color.FromArgb(246, 248, 250);
            b.Padding = new Padding(12, 6, 12, 6);
            b.Margin = new Padding(6, 0, 0, 0);
            b.Cursor = Cursors.Hand;
            b.Font = new Font("Segoe UI", 9.75f, primary ? FontStyle.Bold : FontStyle.Regular);
            return b;
        }

        private void OnDragEnter(object sender, DragEventArgs e)
        {
            if (e.Data.GetDataPresent(DataFormats.FileDrop)) e.Effect = DragDropEffects.Copy;
        }

        private void OnDragDrop(object sender, DragEventArgs e)
        {
            string[] paths = e.Data.GetData(DataFormats.FileDrop) as string[];
            if (paths != null) AddPaths(paths);
        }

        private void OnFilesDropped(string[] paths)
        {
            AddPaths(paths);
        }

        private void PickFiles()
        {
            if (_busy) return;
            using (OpenFileDialog d = new OpenFileDialog())
            {
                d.Multiselect = true;
                d.Title = "Выбери демки";
                d.Filter = "CS2 demos (*.dem;*.zst;*.gz)|*.dem;*.zst;*.gz|All files (*.*)|*.*";
                if (d.ShowDialog(this) == DialogResult.OK) AddPaths(d.FileNames);
            }
        }

        private void AddPaths(string[] paths)
        {
            int added = 0;
            foreach (string raw in paths)
            {
                if (Directory.Exists(raw))
                {
                    string[] files;
                    try { files = Directory.GetFiles(raw); }
                    catch { continue; }
                    foreach (string f in files)
                    {
                        if (IsDemo(f) && AddFile(f)) added++;
                    }
                }
                else if (File.Exists(raw))
                {
                    if (IsDemo(raw))
                    {
                        if (AddFile(raw)) added++;
                    }
                    else
                    {
                        AppendLog("Пропущен (не демка): " + raw);
                    }
                }
            }
            if (added > 0)
            {
                _status.Text = "Добавлено файлов: " + added;
                UpdateButtons();
            }
            else if (paths.Length > 0)
            {
                _status.Text = "Файлы не добавлены.";
            }
        }

        private static bool IsDemo(string path)
        {
            string p = path.ToLowerInvariant();
            return p.EndsWith(".dem") || p.EndsWith(".dem.zst") ||
                   p.EndsWith(".dem.gz") || p.EndsWith(".dem.bz2");
        }

        private bool AddFile(string path)
        {
            string full = Path.GetFullPath(path);
            foreach (Job j in _jobs)
            {
                if (string.Equals(j.Input, full, StringComparison.OrdinalIgnoreCase)) return false;
            }
            long size = 0;
            try { size = new FileInfo(full).Length; }
            catch { }
            Job job = new Job();
            job.Input = full;
            job.Item = new ListViewItem(new string[] { Path.GetFileName(full), FormatSize(size), "В очереди" });
            job.Item.Tag = job;
            _jobs.Add(job);
            _list.Items.Add(job.Item);
            return true;
        }

        private static string FormatSize(long n)
        {
            if (n < 1024) return n + " B";
            if (n < 1024L * 1024L) return (n / 1024.0).ToString("0.0") + " KB";
            return (n / 1024.0 / 1024.0).ToString("0.0") + " MB";
        }

        private void RemoveSelected()
        {
            if (_busy) return;
            List<ListViewItem> selected = new List<ListViewItem>();
            foreach (ListViewItem item in _list.SelectedItems) selected.Add(item);
            foreach (ListViewItem item in selected)
            {
                Job job = item.Tag as Job;
                if (job != null) _jobs.Remove(job);
                item.Remove();
            }
            UpdateButtons();
        }

        private void UpdateButtons()
        {
            bool idle = !_busy;
            _fixButton.Enabled = idle && _jobs.Count > 0;
            _removeButton.Enabled = idle && _jobs.Count > 0;
            _addButton.Enabled = idle;
            _showButton.Enabled = idle;
            _copyButton.Enabled = idle;
        }

        private void StartFix()
        {
            if (_busy || _jobs.Count == 0) return;
            if (!File.Exists(_cliPath))
            {
                MessageBox.Show(this, "Рядом с программой не найден cli.js.\nСкачай папку целиком, а не только exe.", "CS2 Demo Fixer", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }
            _busy = true;
            _progress.Visible = true;
            _status.Text = "Обработка...";
            UpdateButtons();
            _log.AppendText(Environment.NewLine);
            Thread t = new Thread(ProcessAll);
            t.IsBackground = true;
            t.Start();
        }

        private void ProcessAll()
        {
            int ok = 0, unchanged = 0, failed = 0;
            Job[] jobs = _jobs.ToArray();
            foreach (Job job in jobs)
            {
                string output = OutputPath(job.Input);
                job.Output = output;
                SetJobStatus(job, "Обработка...");
                AppendLog("=== " + Path.GetFileName(job.Input) + " ===");
                try
                {
                    string stdout, stderr;
                    int code = Backend.RunNode(_cliPath, job.Input, output, out stdout, out stderr);

                    if (!string.IsNullOrEmpty(stdout)) AppendLog(stdout);
                    if (!string.IsNullOrEmpty(stderr)) AppendLog(stderr);

                    if (code == 0)
                    {
                        if (File.Exists(output))
                        {
                            _lastOutput = output;
                            SetJobStatus(job, "Готово");
                            ok++;
                        }
                        else
                        {
                            SetJobStatus(job, "Без изменений");
                            unchanged++;
                        }
                    }
                    else
                    {
                        SetJobStatus(job, "Ошибка");
                        failed++;
                    }
                }
                catch (Win32Exception ex)
                {
                    AppendLog("Не удалось запустить Node.js: " + ex.Message);
                    AppendLog("Установи Node.js 22.15+ с nodejs.org или задай путь в переменной CS2DEMOFIX_NODE.");
                    SetJobStatus(job, "Нет Node.js");
                    failed++;
                }
                catch (Exception ex)
                {
                    AppendLog("Ошибка: " + ex.Message);
                    SetJobStatus(job, "Ошибка");
                    failed++;
                }
            }
            Finish(ok, unchanged, failed);
        }

        private void Finish(int ok, int unchanged, int failed)
        {
            if (IsDisposed || !IsHandleCreated) return;
            try
            {
                BeginInvoke((MethodInvoker)delegate
                {
                    _busy = false;
                    _progress.Visible = false;
                    _status.Text = "Готово: " + ok + ", без изменений: " + unchanged + ", ошибок: " + failed;
                    UpdateButtons();
                });
            }
            catch { }
        }

        private void SetJobStatus(Job job, string text)
        {
            if (IsDisposed || !IsHandleCreated) return;
            try
            {
                BeginInvoke((MethodInvoker)delegate
                {
                    if (job.Item != null) job.Item.SubItems[2].Text = text;
                });
            }
            catch { }
        }

        private void AppendLog(string text)
        {
            if (IsDisposed || !IsHandleCreated) return;
            try
            {
                BeginInvoke((MethodInvoker)delegate
                {
                    _log.AppendText(text + Environment.NewLine);
                });
            }
            catch { }
        }

        private static string OutputPath(string input)
        {
            string name = Path.GetFileName(input);
            name = Regex.Replace(name, @"\.(zst|gz|bz2)$", "", RegexOptions.IgnoreCase);
            name = Regex.Replace(name, @"[._]dem$", "", RegexOptions.IgnoreCase);
            string output = Path.Combine(Path.GetDirectoryName(input), name + "-fixed.dem");
            if (string.Equals(Path.GetFullPath(output), Path.GetFullPath(input), StringComparison.OrdinalIgnoreCase))
            {
                output = Path.Combine(Path.GetDirectoryName(input), name + "-fixed-1.dem");
            }
            return output;
        }

        private void ShowInFolder()
        {
            string path = SelectedPath();
            if (path == null)
            {
                _status.Text = "Выбери файл в списке.";
                return;
            }
            try
            {
                if (File.Exists(path))
                    Process.Start("explorer.exe", "/select,\"" + path + "\"");
                else
                    Process.Start("explorer.exe", "\"" + Path.GetDirectoryName(path) + "\"");
            }
            catch (Exception ex)
            {
                AppendLog("Не удалось открыть папку: " + ex.Message);
            }
        }

        private void CopyPlaydemo()
        {
            string path = SelectedPath();
            if (path == null)
            {
                _status.Text = "Выбери файл в списке.";
                return;
            }
            string name = Path.GetFileName(path);
            name = Regex.Replace(name, @"\.(zst|gz|bz2)$", "", RegexOptions.IgnoreCase);
            name = Regex.Replace(name, @"\.dem$", "", RegexOptions.IgnoreCase);
            try
            {
                Clipboard.SetText("playdemo " + name);
                _status.Text = "Скопировано: playdemo " + name;
            }
            catch (Exception ex)
            {
                AppendLog("Не удалось скопировать: " + ex.Message);
            }
        }

        private string SelectedPath()
        {
            if (_list.SelectedItems.Count > 0)
            {
                Job job = _list.SelectedItems[0].Tag as Job;
                if (job != null)
                {
                    if (!string.IsNullOrEmpty(job.Output) && File.Exists(job.Output)) return job.Output;
                    return job.Input;
                }
            }
            return _lastOutput;
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (_busy)
            {
                e.Cancel = true;
                _status.Text = "Дождись окончания обработки.";
                return;
            }
            base.OnFormClosing(e);
        }
    }

    internal sealed class DropPanel : Panel
    {
        public event Action<string[]> FilesDropped;
        private readonly Font _titleFont;
        private bool _hot;

        public DropPanel()
        {
            DoubleBuffered = true;
            AllowDrop = true;
            BackColor = Color.FromArgb(250, 250, 250);
            Cursor = Cursors.Hand;
            _titleFont = new Font("Segoe UI", 12f, FontStyle.Bold);
            DragEnter += DropDragEnter;
            DragLeave += delegate { _hot = false; Invalidate(); };
            DragDrop += DropDragDrop;
        }

        private void DropDragEnter(object sender, DragEventArgs e)
        {
            if (e.Data.GetDataPresent(DataFormats.FileDrop))
            {
                e.Effect = DragDropEffects.Copy;
                _hot = true;
                Invalidate();
            }
        }

        private void DropDragDrop(object sender, DragEventArgs e)
        {
            _hot = false;
            Invalidate();
            string[] paths = e.Data.GetData(DataFormats.FileDrop) as string[];
            if (paths != null && FilesDropped != null) FilesDropped(paths);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            Color border = _hot ? Color.FromArgb(31, 35, 40) : Color.FromArgb(208, 215, 222);
            using (Pen pen = new Pen(border, 2f))
            {
                pen.DashStyle = DashStyle.Dash;
                e.Graphics.DrawRectangle(pen, 1, 1, Width - 3, Height - 3);
            }
            int cy = Height / 2;
            TextRenderer.DrawText(e.Graphics, "Перетащи сюда демку", _titleFont,
                new Rectangle(0, cy - 30, Width, 30), Color.FromArgb(31, 35, 40),
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
            TextRenderer.DrawText(e.Graphics, "или нажми, чтобы выбрать файлы", Font,
                new Rectangle(0, cy, Width, 24), Color.FromArgb(110, 119, 129),
                TextFormatFlags.HorizontalCenter | TextFormatFlags.Top);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) _titleFont.Dispose();
            base.Dispose(disposing);
        }
    }
}
